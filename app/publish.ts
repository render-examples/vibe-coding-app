/**
 * publish-app, and every other write to the apps repository. Each write
 * clones the repository into its own sandbox, makes one change, commits only
 * one app's directory and the root Blueprint, and pushes.
 */
import { type TaskContext, task } from "@renderinc/sdk/workflows";
import {
	appPath,
	appRelativePath,
	factoryConfig,
} from "../factory.config.js";
import {
	appBlueprint,
	declaredResources,
	joinServiceDir,
	rootBlueprint,
} from "./blueprint.js";
import { appsRepo } from "./config.js";
import {
	type AppSpec,
	appSpecSchema,
	type PublishAppInput,
	publishAppInputSchema,
} from "./contracts.js";
import { readAppFiles, writeAppFiles } from "./files.js";
import {
	cloneAppsRepo,
	commitPaths,
	headChangedPaths,
	pushVerified,
} from "./git.js";
import { githubToken } from "./github.js";
import {
	connectSandbox,
	createSandbox,
	type Sandbox,
	shellEscape,
} from "./sandbox.js";

/** publish-app makes one commit and one push. */
const PUBLISH_TIMEOUT_SECONDS = 10 * 60;

/**
 * Copy the app's files out of the run's sandbox into a fresh clone of the
 * apps repository, in a separate sandbox. There, write factory.json, the
 * app's render.yaml and README, and the root Blueprint from the spec, commit
 * them with the app, and push. Render deploys the push, so the parent starts
 * this only after verify-app passes. Returns the pushed commit (null when no
 * file changed) and the services Render will redeploy for it.
 *
 * The builder can run any command in the run's sandbox, leave a process
 * running, and even replace git. So the GitHub token never enters that
 * sandbox, and publish-app reads the app's files from it only as data.
 *
 * Render does not retry it. A retry after the push would find nothing to
 * commit, and the run would end as if the push changed no files.
 */
export const publishAppTask = task(
	{
		name: "publish-app",
		plan: "flex",
		timeoutSeconds: PUBLISH_TIMEOUT_SECONDS,
		retry: { maxRetries: 0, waitDurationMs: 0 },
	},
	async function publishApp(
		_tasks: TaskContext,
		input: PublishAppInput,
	): Promise<PublishResult> {
		const { sandboxId, spec, message } = publishAppInputSchema.parse(input);
		const repoUrl = appsRepo().url;
		const appDir = appPath(spec.user, spec.appName);
		// verify-app read the same files. An error here means that they
		// changed after it.
		const built = await readAppFiles(connectSandbox(sandboxId), appDir);
		if ("error" in built) {
			throw new Error(`publish-app did not copy the app. ${built.error}`);
		}
		const published = await inAppsClone(
			PUBLISH_TIMEOUT_SECONDS,
			async (clone): Promise<PublishResult> => {
				const commit = await commitAndPush(clone, spec, message, async () => {
					await writeAppFiles(clone.sandbox, appDir, built.files);
					await writeBlueprints(clone.sandbox, spec, appDir, repoUrl);
				});
				if (!commit) return { commit, changedServices: [] };
				return {
					commit,
					changedServices: servicesChangedBy(
						spec,
						await headChangedPaths(clone.sandbox),
					),
				};
			},
		);
		console.log(
			JSON.stringify({
				event: "app_published",
				user: spec.user,
				appName: spec.appName,
				...published,
			}),
		);
		return published;
	},
);

export interface PublishResult {
	/** The pushed commit, or null when no file changed. */
	commit: string | null;
	/** The manifest services the commit will redeploy. */
	changedServices: string[];
}

/**
 * The manifest services whose directory contains a path the commit changes.
 * Each service's buildFilter is its directory, so Render redeploys only
 * these. A rootDir of "." is the app directory, which holds factory.json.
 */
export function servicesChangedBy(
	spec: AppSpec,
	changedPaths: readonly string[],
): string[] {
	const root = appRelativePath(spec.user, spec.appName);
	return spec.manifest.services
		.filter((service) => {
			const dir = joinServiceDir(root, service.rootDir);
			return changedPaths.some((path) => path.startsWith(`${dir}/`));
		})
		.map((service) => service.name);
}

async function writeBlueprints(
	sandbox: Sandbox,
	spec: AppSpec,
	appDir: string,
	repoUrl: string,
): Promise<void> {
	// The .gitignore arrives with the app's files. verify() writes it, because
	// it must build from the same files this commit holds.
	await sandbox.writeFile(
		`${appDir}/factory.json`,
		`${JSON.stringify(spec, null, 2)}\n`,
	);
	await sandbox.writeFile(`${appDir}/render.yaml`, appBlueprint(spec));
	await sandbox.writeFile(`${appDir}/README.md`, appReadme(spec, repoUrl));

	await writeRootBlueprint(sandbox);
}

/**
 * Regenerate the repository-root Blueprint from every app's factory.json.
 *
 * Derived state, never merged: a concurrent run adds its own app to the same
 * file. When another run pushes first, the change that calls this reruns on
 * the new tip, and the file gets both runs' apps.
 *
 * It reads the specs from a clone no agent used. There, the builder's files
 * cover only its own app, and publish-app wrote that app's factory.json.
 */
export async function writeRootBlueprint(sandbox: Sandbox): Promise<void> {
	const specs = await readAllSpecs(sandbox);
	await sandbox.writeFile(
		`${factoryConfig.repoDir}/${factoryConfig.blueprintPath}`,
		rootBlueprint(specs),
	);
}

/**
 * Every app's spec in the clone. A spec counts only in the directory of the
 * app it names, so a file in one app's directory cannot declare resources for
 * another app.
 */
async function readAllSpecs(sandbox: Sandbox): Promise<AppSpec[]> {
	const root = `${factoryConfig.repoDir}/${factoryConfig.appsDir}`;
	const found = await sandbox.run(
		`find ${shellEscape(root)} -mindepth 3 -maxdepth 3 -name factory.json -print 2>/dev/null || true`,
	);

	const specs: AppSpec[] = [];
	for (const path of found.output.split("\n").map((line) => line.trim())) {
		if (!path.startsWith(`${root}/`)) continue;
		const raw = await sandbox.run(`cat ${shellEscape(path)}`);
		if (raw.exitCode !== 0) continue;
		try {
			const spec = appSpecSchema.parse(JSON.parse(raw.output));
			const [user, appName] = path.slice(root.length + 1).split("/");
			if (spec.user !== user || spec.appName !== appName) {
				console.warn(
					JSON.stringify({
						event: "skipped_app_spec",
						path,
						reason: `it names ${spec.user}/${spec.appName}`,
					}),
				);
				continue;
			}
			specs.push(spec);
		} catch {
			console.warn(JSON.stringify({ event: "skipped_app_spec", path }));
		}
	}
	return specs;
}

/** A sandbox that holds a clone of the apps repository, and how to push it. */
interface AppsClone {
	sandbox: Sandbox;
	token: string;
	remoteUrl: string;
}

/**
 * Clone the apps repository into a new sandbox, do the work, and terminate
 * the sandbox. No agent uses this sandbox, so the GitHub token can enter it.
 * The token is fetched just before the clone: an installation token expires
 * after an hour, and a run can take two.
 *
 * Each push makes its own clone, so it starts from the newest commit, and no
 * sandbox stays up while a run or a delete waits.
 */
export async function inAppsClone<T>(
	timeoutSeconds: number,
	work: (clone: AppsClone) => Promise<T>,
): Promise<T> {
	const repo = appsRepo();
	// githubRemoteUrl in git.ts always clones from github.com.
	const sandbox = await createSandbox({
		timeoutSeconds,
		egress: ["github.com"],
	});
	try {
		const token = await githubToken();
		const remoteUrl = await cloneAppsRepo(
			sandbox,
			token,
			repo,
			factoryConfig.branch,
		);
		return await work({ sandbox, token, remoteUrl });
	} finally {
		await sandbox
			.terminate()
			.catch((error) => console.error("Failed to terminate sandbox:", error));
	}
}

/**
 * Apply one app's change in the clone, commit it, and push. The commit holds
 * only the app's directory and the root Blueprint. When another run pushes
 * first, `change` reruns on the new tip. A change that touches no file makes
 * no commit. Returns the pushed commit, or null.
 */
export async function commitAndPush(
	clone: AppsClone,
	app: { user: string; appName: string },
	message: string,
	change: () => Promise<void>,
): Promise<string | null> {
	const paths = [
		appRelativePath(app.user, app.appName),
		factoryConfig.blueprintPath,
	];
	const commit = async () => {
		await change();
		return commitPaths(clone.sandbox, message, paths);
	};
	if (!(await commit())) return null;
	return pushVerified(
		clone.sandbox,
		clone.token,
		clone.remoteUrl,
		factoryConfig.branch,
		paths,
		commit,
	);
}

function appReadme(spec: AppSpec, repoUrl: string): string {
	const relative = appRelativePath(spec.user, spec.appName);
	return [
		`# ${spec.appName}`,
		"",
		spec.summary,
		"",
		`Generated by vibe-coding-app from the prompt: "${oneLine(spec.prompt)}"`,
		"",
		"## Infrastructure",
		"",
		...declaredResources(spec).map((resource) => `- ${resource}`),
		"",
		"## Deploying this app on its own",
		"",
		"It is already deployed as part of the factory's Blueprint at the",
		"repository root. To run it as its own Blueprint instead, create a new",
		`Blueprint from ${repoUrl} with the Blueprint Path set to:`,
		"",
		"```text",
		`${relative}/render.yaml`,
		"```",
		"",
	].join("\n");
}

export function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").slice(0, 120);
}

