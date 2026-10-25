/**
 * The deploy stage of prompt-to-app: wait for Render to deploy the push,
 * repair a failed deploy, and smoke-test the live app.
 */
import type { TaskContext } from "@renderinc/sdk/workflows";
import { factoryConfig } from "../factory.config.js";
import {
	declaredResources,
	type ResourceNames,
	resourceNames,
} from "./blueprint.js";
import { runBuilder } from "./build.js";
import type { AppSpec, Service, WorkflowResult } from "./contracts.js";
import { redactSecrets } from "./policy.js";
import { publishAppTask } from "./publish.js";
import {
	type BlueprintRecord,
	type DeployOutcome,
	fetchDeployLogs,
	findBlueprint,
	latestDeploys,
	pageContains,
	type ServiceRecord,
	waitForDeploy,
	waitForHttpOk,
	waitForServices,
} from "./render.js";
import type { Sandbox } from "./sandbox.js";
import { setRunStage, setRunUrls, touchRun } from "./store.js";
import { verifyAppTask } from "./verify.js";

const MAX_DEPLOY_REPAIR_ROUNDS = 2;
const SERVICE_TIMEOUT_MS = 6 * 60 * 1000;
const DEPLOY_TIMEOUT_MS = 15 * 60 * 1000;
/**
 * Render can route a new onrender.com hostname some minutes after the first
 * deploy of its service is live, and until then the hostname gives 404. For a
 * new static site that can last more than 3 minutes, so the first check of
 * each public URL waits this long.
 */
const ROUTE_TIMEOUT_MS = 10 * 60 * 1000;
/** The data check starts after the health check of the same host passed. */
const DATA_TIMEOUT_MS = 3 * 60 * 1000;
/** The Render Dashboard shows each task input, so keep the logs in it small. */
const MAX_DEPLOY_LOG_CHARS = 4_000;

export interface DeployContext {
	/** Runs the builder, verify-app, and publish-app for a repair. */
	tasks: TaskContext;
	sandbox: Sandbox;
	workspaceId: string;
	repoUrl: string;
	spec: AppSpec;
	appDir: string;
	runId: string;
	summary: string;
	databaseUrl: string | null;
	/** From deploysBeforePublish(), read before the push. */
	deploysBefore: ReadonlyMap<string, string>;
	/** The manifest services the push will redeploy, from publish-app. */
	changedServices: readonly string[];
}

/** The services of the app on Render, keyed by Render service name. */
type AppServices = Map<string, ServiceRecord>;

/** A deploy step's value for the next step, or the run's final result. */
type Step<T> = { value: T } | { end: WorkflowResult };

/**
 * The newest deploy of each of the app's services that already exists, keyed
 * by Render service name. Right after the push, these are still the newest
 * deploys, so a wait must look for a newer one.
 */
export function deploysBeforePublish(
	workspaceId: string,
	spec: AppSpec,
): Promise<Map<string, string>> {
	return latestDeploys(workspaceId, [...resourceNames(spec).services.values()]);
}

/**
 * The deploy stage after the first push: find the Blueprint, wait for it to
 * create the services, wait for their deploys and repair failures, and
 * smoke-test the live app.
 */
export async function awaitDeployment(
	ctx: DeployContext,
): Promise<WorkflowResult> {
	const names = resourceNames(ctx.spec);
	const heartbeat = runHeartbeat(ctx.runId);

	// Errors are not caught. awaiting_blueprint tells the user to create a
	// Blueprint, so only a lookup that finds none may return it. findBlueprint
	// retries failed requests, and a persistent error ends the run with that
	// error as its summary.
	const blueprint = await findBlueprint({
		workspaceId: ctx.workspaceId,
		repo: ctx.repoUrl,
		branch: factoryConfig.branch,
		path: factoryConfig.blueprintPath,
	});
	if (!blueprint) return awaitingBlueprint(ctx);

	const services = await waitForAppServices(ctx, blueprint, names, heartbeat);
	if ("end" in services) return services.end;

	const deployed = await deployWithRepairs(
		ctx,
		names,
		services.value,
		heartbeat,
	);
	if ("end" in deployed) return deployed.end;

	return smokeTest(
		ctx,
		{ spec: deployed.value, names, services: services.value, blueprint },
		heartbeat,
	);
}

function awaitingBlueprint(ctx: DeployContext): WorkflowResult {
	return {
		status: "awaiting_blueprint",
		user: ctx.spec.user,
		appName: ctx.spec.appName,
		summary: [
			ctx.summary,
			`Committed to ${ctx.repoUrl} on ${factoryConfig.branch}, but no Blueprint in workspace ${ctx.workspaceId} is watching ${factoryConfig.blueprintPath}.`,
			"Create one once in that workspace in the Render Dashboard (New > Blueprint) and every later run deploys on push.",
		].join("\n\n"),
	};
}

/** Wait for the Blueprint sync to create all of the app's services. */
async function waitForAppServices(
	ctx: DeployContext,
	blueprint: BlueprintRecord,
	names: ResourceNames,
	heartbeat: (detail: string) => Promise<void>,
): Promise<Step<AppServices>> {
	const wanted = [...names.services.values()];
	await setRunStage(
		ctx.runId,
		"waiting_for_services",
		`Waiting for ${wanted.length} Blueprint service(s)`,
	);
	const services = await waitForServices(
		ctx.workspaceId,
		wanted,
		SERVICE_TIMEOUT_MS,
		heartbeat,
	);
	if (services.size < wanted.length) {
		const missing = wanted.filter((name) => !services.has(name));
		return {
			end: {
				status: "deploy_failed",
				summary: [
					`Blueprint ${blueprint.id} did not produce ${missing.join(", ")} within ${SERVICE_TIMEOUT_MS / 60000} minutes.`,
					blueprint.autoSync
						? `Blueprint status is "${blueprint.status}".`
						: "Auto Sync is off for this Blueprint, so the push did not sync. Turn it on or sync manually.",
				].join(" "),
			},
		};
	}

	await setRunUrls(ctx.runId, {
		webUrl: urlOf(services, names.web),
		apiUrl: urlOf(services, names.api),
	});
	return { value: services };
}

/**
 * Wait for the push's deploys and repair failed ones, up to
 * MAX_DEPLOY_REPAIR_ROUNDS times. Returns the live spec, because a repair
 * replaces the manifest. Each repair round:
 * 1. workflow code reads and redacts each failed deploy's logs
 * 2. the builder fixes the error the logs name
 * 3. verify-app checks the fix, and publish-app rewrites factory.json and
 *    the Blueprints from the repaired manifest and pushes
 * 4. the next round waits for a new deploy of each failed service
 */
async function deployWithRepairs(
	ctx: DeployContext,
	names: ResourceNames,
	services: AppServices,
	heartbeat: (detail: string) => Promise<void>,
): Promise<Step<AppSpec>> {
	let spec = ctx.spec;
	let waits = firstWaits(ctx, names, services);
	for (let round = 0; ; round++) {
		const failed = await waitForDeploys(ctx.runId, waits, round, heartbeat);
		if (failed.length === 0) return { value: spec };

		// Another round cannot repair a service the push did not redeploy: the
		// builder would read the same failed deploy again.
		if (
			round === MAX_DEPLOY_REPAIR_ROUNDS ||
			failed.some(({ deploy }) => deploy.result === "not_started")
		) {
			return {
				end: { status: "deploy_failed", summary: deployFailures(failed, round) },
			};
		}

		const repaired = await repairDeploys(ctx, spec, failed, round);
		if ("end" in repaired) return repaired;
		spec = repaired.value;

		// Right after the repair push, each failed service's newest deploy is
		// still the failed one. A live service the repair did not change gets
		// no new deploy, so it is not waited on.
		waits = failed.map(({ service, deploy }) => ({
			service,
			after: deploy.deployId,
		}));
	}
}

/** A service to wait for after a push. */
interface DeployWait {
	service: ServiceRecord;
	/** The deploy from before the push, or null. See waitForDeploy(). */
	after: string | null;
}

/** A service, and the deploy its wait ended with. */
interface DeployResult {
	service: ServiceRecord;
	deploy: DeployOutcome;
}

/**
 * The first round waits for every service. A service that existed before the
 * push, and whose files the push changed, waits for a deploy newer than its
 * pre-push deploy. Render does not redeploy a service whose files did not
 * change, so its newest deploy is its result.
 */
function firstWaits(
	ctx: DeployContext,
	names: ResourceNames,
	services: AppServices,
): DeployWait[] {
	const changed = new Set(
		ctx.changedServices.map((name) => names.services.get(name)),
	);
	return [...services.values()].map((service) => ({
		service,
		after: changed.has(service.name)
			? (ctx.deploysBefore.get(service.name) ?? null)
			: null,
	}));
}

/** Wait for each deploy, and return the ones that did not go live. */
async function waitForDeploys(
	runId: string,
	waits: readonly DeployWait[],
	round: number,
	heartbeat: (detail: string) => Promise<void>,
): Promise<DeployResult[]> {
	await setRunStage(
		runId,
		"waiting_for_deploys",
		`Waiting for ${waits.length} deploy(s), round ${round + 1}`,
	);
	const outcomes = await Promise.all(
		waits.map(async ({ service, after }) => ({
			service,
			deploy: await waitForDeploy(service.id, {
				timeoutMs: DEPLOY_TIMEOUT_MS,
				after,
				onPoll: (detail) => heartbeat(`${service.name}: ${detail}`),
			}),
		})),
	);
	return outcomes.filter(({ deploy }) => deploy.result !== "live");
}

/**
 * One repair round: the builder fixes the failed deploys from their redacted
 * logs, verify-app checks the fix, and publish-app pushes it. Returns the
 * repaired spec.
 */
async function repairDeploys(
	ctx: DeployContext,
	spec: AppSpec,
	failed: readonly DeployResult[],
	round: number,
): Promise<Step<AppSpec>> {
	// No agent can read logs, so workflow code reads them.
	const reports = await Promise.all(
		failed.map((failure) => failedDeployReport(ctx.workspaceId, failure)),
	);
	const buildOutput = await runBuilder(
		ctx.tasks,
		ctx.sandbox,
		ctx.appDir,
		[
			"The app built and passed verification in the sandbox, but Render's deploy failed.",
			"",
			reports.join("\n\n"),
			"",
			"Find the error in the logs and fix exactly what it names.",
			"Keep the same services and databases in the manifest. Do not add, remove, or rename one, and do not change the kind of a service.",
		].join("\n"),
		`builder-deploy-fix-${round + 1}`,
	);

	// The repaired manifest must keep every resource, because the deploy waits
	// only on services from the first push. The rest of the spec stays the
	// same: resourcePrefix is part of every resource name.
	const repaired: AppSpec = { ...spec, manifest: buildOutput.manifest };
	const rejection = resourceChange(spec, repaired);
	if (rejection) {
		return {
			end: {
				status: "deploy_failed",
				summary: `Deploy repair round ${round + 1} was not pushed. ${rejection}`,
			},
		};
	}

	const { failures } = await ctx.tasks.run(verifyAppTask, {
		sandboxId: ctx.sandbox.id,
		user: repaired.user,
		appName: repaired.appName,
		manifest: repaired.manifest,
		databaseUrl: ctx.databaseUrl,
	});
	if (failures.length > 0) {
		return {
			end: {
				status: "deploy_failed",
				summary: `Deploy repair round ${round + 1} failed local verification: ${failures.join("; ").slice(0, 1_000)}`,
			},
		};
	}

	// Render deploys from the root Blueprint, which is generated from every
	// factory.json. If they kept the old manifest, Render would keep the old
	// commands, paths, and env vars.
	const { commit } = await ctx.tasks.run(publishAppTask, {
		sandboxId: ctx.sandbox.id,
		spec: repaired,
		message: `Fix Render deploy for ${repaired.user}/${repaired.appName} (round ${round + 1})`,
	});
	// With no commit, Render deploys nothing and the failed deploys stay.
	// Render keeps serving a failed service's last live deploy, so the smoke
	// checks could pass against the old code.
	if (!commit) {
		return {
			end: {
				status: "deploy_failed",
				summary: `Deploy repair round ${round + 1} changed no files, so Render has no new commit to deploy. ${deployFailures(failed, round)}`,
			},
		};
	}
	return { value: repaired };
}

/**
 * The checks that a deploy status cannot make: each public URL answers, the
 * storefront names the public hostname of the API, and the API returns data
 * that the storefront's origin can read.
 */
async function smokeTest(
	ctx: DeployContext,
	app: {
		spec: AppSpec;
		names: ResourceNames;
		services: AppServices;
		blueprint: BlueprintRecord;
	},
	heartbeat: (detail: string) => Promise<void>,
): Promise<WorkflowResult> {
	const { spec, names, services, blueprint } = app;
	await setRunStage(
		ctx.runId,
		"smoke_testing",
		"Deploys are live. The workflow checks public URLs, the API host in the storefront, data, and CORS",
	);
	const storefrontUrl = urlOf(services, names.web);
	const apiUrl = urlOf(services, names.api);
	// An API-only app has no storefront, so the API is the public URL.
	const webUrl = storefrontUrl ?? apiUrl;
	if (!webUrl) {
		return {
			status: "deploy_failed",
			summary: `${names.web ?? names.api} deployed but Render reported no public URL.`,
		};
	}

	const site = await waitForHttpOk(webUrl, ROUTE_TIMEOUT_MS, {
		onPoll: heartbeat,
	});
	if (!site.ok) {
		return {
			status: "deploy_failed",
			summary: `${webUrl} did not return a successful response in ${ROUTE_TIMEOUT_MS / 60000} minutes (last status ${site.status}).`,
		};
	}

	const apiService = spec.manifest.services.find(
		(service) => service.kind === "web_service",
	);
	if (apiUrl && apiService) {
		const failure =
			(await smokeStorefront(storefrontUrl, apiUrl)) ??
			(await smokeApi(apiUrl, apiService, storefrontUrl, heartbeat));
		if (failure) {
			return {
				status: "deploy_failed",
				summary: `${failure}\n\nStorefront: ${webUrl}\nAPI: ${apiUrl}`,
			};
		}
	}

	const hasDb = (spec.manifest.databases ?? []).length > 0;

	return {
		status: "deployed",
		user: spec.user,
		appName: spec.appName,
		webUrl,
		apiUrl,
		summary: [
			ctx.summary,
			`Deployed ${services.size} service(s)${hasDb ? " and a Postgres database" : ""} from ${factoryConfig.blueprintPath} (Blueprint ${blueprint.id}).`,
		].join("\n\n"),
	};
}

function urlOf(services: AppServices, name: string | null): string | null {
	return name ? (services.get(name)?.url ?? null) : null;
}

/** Round 0 waits for the first push, and each later round for a repair. */
function deployFailures(
	failed: readonly DeployResult[],
	round: number,
): string {
	const push = round === 0 ? "the push" : "the repair push";
	const lines = failed.map(({ service, deploy }) =>
		deploy.result === "not_started"
			? `${service.name}: ${push} did not start a new deploy in ${DEPLOY_TIMEOUT_MS / 60000} minutes. ` +
				`The newest deploy is still ${deploy.deployId} ("${deploy.status}").`
			: `${service.name} ended as "${deploy.status}".`,
	);
	if (failed.some(({ deploy }) => deploy.result === "not_started")) {
		lines.push(
			"Render deploys a service again when a commit changes files in its rootDir or its entry in the Blueprint.",
		);
	}
	return lines.join(" ");
}

/**
 * One failed deploy, with the last lines of its logs. Redact before cutting:
 * a cut can split a secret, and redactSecrets() cannot match half of one.
 */
async function failedDeployReport(
	workspaceId: string,
	{ service, deploy }: DeployResult,
): Promise<string> {
	const logs = deploy.deployId
		? redactSecrets(
				await fetchDeployLogs(service.id, deploy.deployId, workspaceId),
			).slice(-MAX_DEPLOY_LOG_CHARS)
		: "";
	return [
		`Service "${service.name}" (${service.id}), deploy ${deploy.deployId ?? "none"}: deploy status "${deploy.status}"`,
		logs ? `The last lines of its logs:\n${logs}` : "Render gave no logs.",
	].join("\n");
}

/**
 * Why a repaired spec cannot replace the deployed one, or null when both
 * declare the same resources. A removed resource would stay live outside the
 * Blueprint: Render does not delete it, and the factory calls no Render write
 * API. The deploy loop also cannot watch an added resource, because it waits
 * only on services from the first push.
 */
function resourceChange(deployed: AppSpec, repaired: AppSpec): string | null {
	const before = declaredResources(deployed);
	const after = declaredResources(repaired);
	const added = after.filter((resource) => !before.includes(resource));
	const removed = before.filter((resource) => !after.includes(resource));
	if (added.length === 0 && removed.length === 0) return null;

	const changes = [
		...(added.length > 0 ? [`adds ${added.join(", ")}`] : []),
		...(removed.length > 0 ? [`removes ${removed.join(", ")}`] : []),
	];
	return (
		`The repair ${changes.join(" and ")}. ` +
		"A repair can change commands, paths, and env vars, but not the resources that the Blueprint declares."
	);
}

/**
 * The storefront build writes the API hostname into its bundle, and only a
 * browser uses it. The API checks cannot catch a wrong hostname: the
 * private-network `host`, for example, passes all of them.
 */
async function smokeStorefront(
	webUrl: string | null,
	apiUrl: string,
): Promise<string | null> {
	if (!webUrl) return null;
	const apiHost = new URL(apiUrl).hostname;
	let found: boolean;
	try {
		found = await pageContains(webUrl, apiHost);
	} catch (error) {
		return (
			`${webUrl} answered once, but a later read of the page or its scripts kept failing, so the workflow ` +
			`could not check it for the API hostname ${apiHost}. ` +
			`${error instanceof Error ? error.message : String(error)}`
		);
	}
	if (found) return null;
	return (
		`${webUrl} does not contain the API hostname ${apiHost} in its HTML or in the scripts that it loads. ` +
		"A browser cannot find the API. Set the storefront env var with fromService envVarKey RENDER_EXTERNAL_HOSTNAME. " +
		"The host property is a name on the private network, and a browser cannot connect to it."
	);
}

/**
 * The checks a deploy status cannot make. "live" means the build succeeded and
 * the health check passed, and the health check is required not to touch the
 * database — so it certifies exactly the part that does not depend on
 * Postgres. Whether the API returns rows, and whether the storefront's origin
 * is allowed to read them, are facts about two services agreeing, invisible to
 * either one's status.
 */
async function smokeApi(
	apiUrl: string,
	service: Service,
	webOrigin: string | null,
	onPoll?: (detail: string) => void | Promise<void>,
): Promise<string | null> {
	const healthPath = service.healthCheckPath ?? "/health";
	const health = await waitForHttpOk(`${apiUrl}${healthPath}`, ROUTE_TIMEOUT_MS, {
		onPoll,
	});
	if (!health.ok) {
		return `${apiUrl}${healthPath} did not answer in ${ROUTE_TIMEOUT_MS / 60000} minutes (last status ${health.status}).`;
	}

	if (!service.dataCheckPath) return null;

	const data = await waitForHttpOk(
		`${apiUrl}${service.dataCheckPath}`,
		DATA_TIMEOUT_MS,
		{
			headers: webOrigin ? { origin: webOrigin } : undefined,
			onPoll,
		},
	);
	if (!data.ok) {
		return (
			`${apiUrl}${service.dataCheckPath} did not answer (last status ${data.status}). ` +
			"The service is live, so its database wiring or its schema is the problem."
		);
	}

	// The storefront is a different origin on a different host, so a browser
	// drops the response without this header even though every server-side
	// check above passed.
	if (webOrigin) {
		const allowed = data.headers.get("access-control-allow-origin");
		if (!allowed || (allowed !== "*" && allowed !== webOrigin)) {
			return (
				`${apiUrl}${service.dataCheckPath} answered, but sent ` +
				`${allowed ? `access-control-allow-origin: ${allowed}` : "no access-control-allow-origin header"} ` +
				`for origin ${webOrigin}. The storefront cannot read the API from a browser.`
			);
		}
	}

	return null;
}

function runHeartbeat(runId: string): (detail: string) => Promise<void> {
	let lastUpdate = 0;
	return async (detail) => {
		if (Date.now() - lastUpdate < 30_000) return;
		lastUpdate = Date.now();
		await touchRun(runId, detail.slice(0, 500));
	};
}
