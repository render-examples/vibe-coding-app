/**
 * The two pipelines in app/workflow.ts, end to end: prompt-to-app (design,
 * build, verify, publish, deploy) and delete-app. The tests drive the task
 * bodies and fake only the system boundaries: the agents, the store, the
 * sandboxes, Git clone and push, GitHub, Render reads, and Render deletes.
 */
import { type TaskContext, TaskRegistry } from "@renderinc/sdk/workflows";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appPath, factoryConfig } from "../factory.config.js";
import { resourceStem } from "../app/blueprint.js";
import {
	type AppSpec,
	type Manifest,
	type Service,
	slug,
} from "../app/contracts.js";
import type { AppFile } from "../app/files.js";
import type { DeployOutcome } from "../app/render.js";
import type { ExecResult, Sandbox } from "../app/sandbox.js";
import type { AppClaim } from "../app/store.js";
import {
	deleteResourcesTask,
	removeFilesTask,
	removeFromBlueprintTask,
	waitForSyncsTask,
} from "../app/delete.js";
import { awaitDeployment, type DeployContext } from "../app/deploy.js";
import { publishAppTask } from "../app/publish.js";
import { verifyAppTask } from "../app/verify.js";
import { deleteApp, promptToApp, uniqueAppName } from "../app/workflow.js";

const mocks = vi.hoisted(() => ({
	architectTask: vi.fn(),
	buildTask: vi.fn(),
	commitPaths: vi.fn(),
	pushVerified: vi.fn(),
	githubToken: vi.fn(),
	cloneAppsRepo: vi.fn(),
	readAppFiles: vi.fn(),
	writeAppFiles: vi.fn(),
	createSandbox: vi.fn(),
	connectSandbox: vi.fn(),
	fetchDeployLogs: vi.fn(),
	findBlueprint: vi.fn(),
	latestDeploys: vi.fn(async () => new Map<string, string>()),
	pageContains: vi.fn(),
	waitForServices: vi.fn(),
	waitForDeploy: vi.fn(),
	waitForHttpOk: vi.fn(),
	deleteAppResources: vi.fn(),
	waitForBlueprintSyncs: vi.fn(),
	claimRunApp: vi.fn(async (): Promise<AppClaim> => ({ claimed: true })),
	deleteRuns: vi.fn(async () => {}),
	failDelete: vi.fn(async () => {}),
	finishRun: vi.fn(async () => {}),
}));

vi.mock("../app/agents.js", () => ({
	architectTask: { name: "architect", func: mocks.architectTask },
	buildTask: { name: "builder", func: mocks.buildTask },
}));

vi.mock("../app/store.js", () => ({
	claimRunApp: mocks.claimRunApp,
	deleteRuns: mocks.deleteRuns,
	failDelete: mocks.failDelete,
	finishRun: mocks.finishRun,
	setDeleteProgress: vi.fn(async () => {}),
	setRunSandbox: vi.fn(async () => {}),
	setRunStage: vi.fn(async () => {}),
	setRunUrls: vi.fn(async () => {}),
	touchRun: vi.fn(async () => {}),
}));

// tests/git.test.ts and tests/files.test.ts run the real commit, push, and
// tar copy. Here the copy moves files between two fake sandboxes.
vi.mock("../app/git.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../app/git.js")>()),
	commitPaths: mocks.commitPaths,
	pushVerified: mocks.pushVerified,
	cloneAppsRepo: mocks.cloneAppsRepo,
}));

vi.mock("../app/github.js", () => ({ githubToken: mocks.githubToken }));

vi.mock("../app/files.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../app/files.js")>()),
	readAppFiles: mocks.readAppFiles,
	writeAppFiles: mocks.writeAppFiles,
}));

vi.mock("../app/sandbox.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../app/sandbox.js")>()),
	createSandbox: mocks.createSandbox,
	connectSandbox: mocks.connectSandbox,
	sandboxGroupId: vi.fn(async () => "sbg-test"),
}));

vi.mock("../app/teardown.js", () => ({
	deleteAppResources: mocks.deleteAppResources,
	waitForBlueprintSyncs: mocks.waitForBlueprintSyncs,
}));

vi.mock("../app/render.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../app/render.js")>()),
	fetchDeployLogs: mocks.fetchDeployLogs,
	findBlueprint: mocks.findBlueprint,
	latestDeploys: mocks.latestDeploys,
	pageContains: mocks.pageContains,
	waitForServices: mocks.waitForServices,
	waitForDeploy: mocks.waitForDeploy,
	waitForHttpOk: mocks.waitForHttpOk,
}));

/* ── Fixtures ─────────────────────────────────────────────────────────── */

const INPUT = {
	prompt: "Sell handmade walnut furniture online",
	user: "demo",
	runId: "run-1",
};
/** The architect names the app "shop"; the run ID "run-1" adds the suffix. */
const APP_NAME = "shop-run1";
const SHOP_APP = { user: "demo", appName: APP_NAME };
const APP_DIR = appPath("demo", APP_NAME);
const APP_SPEC = `${APP_DIR}/factory.json`;
const APP_SOURCE = `${APP_DIR}/web/index.html`;
const ROOT_BLUEPRINT = `${factoryConfig.repoDir}/${factoryConfig.blueprintPath}`;
const STOREFRONT_HTML = `<!doctype html><html><body>${"<p>Walnut chairs, oak tables, and ash stools, made by hand in Portland.</p>".repeat(5)}</body></html>`;
const SHA = "c".repeat(40);

const storefront: Service = {
	name: "web",
	kind: "static_site",
	rootDir: "web",
	runtime: "static",
	buildCommand: "npm ci && npm run build",
	staticPublishPath: "dist",
};

const api: Service = {
	name: "api",
	kind: "web_service",
	rootDir: "api",
	runtime: "node",
	buildCommand: "npm ci && npm run build",
	startCommand: "npm start",
	preDeployCommand: "npm run migrate",
	healthCheckPath: "/health",
	dataCheckPath: "/api/items",
	envVars: [
		{ key: "DATABASE_URL", fromDatabase: { property: "connectionString" } },
	],
};

const siteOnly: Manifest = { services: [storefront] };

const fullstack: Manifest = {
	services: [
		{
			...storefront,
			envVars: [
				{
					key: "VITE_API_HOST",
					fromService: { name: "api", envVarKey: "RENDER_EXTERNAL_HOSTNAME" },
				},
			],
		},
		api,
	],
	databases: [{ name: "db" }],
};

/** A storefront that bundles the private-network host of the API. */
const privateHost: Manifest = {
	services: [
		{
			...storefront,
			envVars: [
				{
					key: "VITE_API_HOST",
					fromService: { name: "api", property: "host" },
				},
			],
		},
	],
};

/** The shop app as its first push published it. */
const spec: AppSpec = {
	user: "demo",
	appName: APP_NAME,
	prompt: INPUT.prompt,
	summary: "A storefront, an API, and Postgres behind it.",
	createdAt: "2026-01-01T00:00:00.000Z",
	// Not the default prefix, so a repair that rebuilt the spec instead of
	// copying it would rename every resource.
	resourcePrefix: "acme",
	manifest: fullstack,
};
const cafe: AppSpec = { ...spec, appName: "cafe", prompt: "A menu for a cafe" };
const CAFE_SPEC = `${appPath("demo", "cafe")}/factory.json`;
const WEB_ID = "srv-acme-demo-shop-run1-web";
const API_ID = "srv-acme-demo-shop-run1-api";

function plan(...kinds: string[]) {
	return {
		appName: "shop",
		summary: "A storefront for handmade walnut furniture.",
		tiers: kinds.map((kind) => ({ kind, reason: "The product needs it." })),
		assetQueries: [],
		brief: {
			pages: ["Home"],
			features: [],
			voice: "Warm and plain",
			content: "Walnut chairs, oak tables, and ash stools.",
		},
	};
}

function json(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

/* ── Harness ──────────────────────────────────────────────────────────── */

/** The name of each subtask that ran, and its input, in order. */
let ran: { name: string; input: unknown }[];

/**
 * Runs each subtask in this process with the body of its task. As on
 * Render, the input and the result go through JSON.
 */
const tasks: TaskContext = {
	run: async (task, ...args) => {
		ran.push({ name: task.name, input: args[0] });
		return wire(await task.func(tasks, ...wire(args)));
	},
};

function wire<T>(value: T): T {
	return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function subtasks(): string[] {
	return ran.map(({ name }) => name);
}

/** Overrides the answer of a fake sandbox to one command. */
type Answer = (command: string) => ExecResult | undefined;

const filesystems = new WeakMap<Sandbox, Map<string, string>>();

/** Specs as readAllSpecs() finds them: apps/<user>/<app>/factory.json. */
const SPEC_PATH = new RegExp(
	`^${factoryConfig.repoDir}/${factoryConfig.appsDir}/[^/]+/[^/]+/factory\\.json$`,
);

/**
 * A sandbox with an in-memory file system. It answers the commands the
 * pipelines run on files, git, the template script, and the boots and
 * probes of verify-app, as a healthy app would. Other commands succeed.
 */
function fakeSandbox(
	id: string,
	files: Map<string, string>,
	answer: Answer = () => undefined,
): Sandbox {
	const run = vi.fn(
		async (command: string) => answer(command) ?? execute(files, command),
	);
	const sandbox = {
		id,
		run,
		async mustRun(command: string, label: string): Promise<string> {
			const result = await run(command);
			if (result.exitCode !== 0) throw new Error(`${label} failed`);
			return result.output;
		},
		async readFile(path: string): Promise<string> {
			return sandbox.mustRun(`cat '${path}'`, `Read ${path}`);
		},
		async writeFile(path: string, contents: string): Promise<void> {
			files.set(path, contents);
		},
		async upload(path: string, data: unknown): Promise<void> {
			files.set(path, String(data));
		},
		terminate: vi.fn(async () => {}),
	};
	filesystems.set(sandbox as unknown as Sandbox, files);
	return sandbox as unknown as Sandbox;
}

function execute(files: Map<string, string>, command: string): ExecResult {
	const ok = (output = ""): ExecResult => ({ output, exitCode: 0 });
	const failed: ExecResult = { output: "", exitCode: 1 };
	const below = (dir: string) =>
		[...files.keys()].filter((path) => path.startsWith(`${dir}/`));

	const cat = command.match(/^cat '([^']+)'$/);
	if (cat) {
		// A build writes the index.html of a static site.
		const contents =
			files.get(cat[1]) ??
			(cat[1].endsWith("/index.html") ? STOREFRONT_HTML : undefined);
		return contents === undefined ? failed : ok(contents);
	}
	const exists = command.match(/^test -e '([^']+)'$/);
	if (exists) return files.has(exists[1]) ? ok() : failed;
	const needs = command.match(/^cd '([^']+)' && test -f (\S+)$/);
	if (needs) return files.has(`${needs[1]}/${needs[2]}`) ? ok() : failed;
	const remove = command.match(/^rm -rf '([^']+)'$/);
	if (remove) {
		for (const path of below(remove[1])) files.delete(path);
		return ok();
	}
	const list = command.match(/^ls -A '([^']+)'$/);
	if (list) return ok(below(list[1]).length > 0 ? "web\n" : "");
	if (command.startsWith("find ")) {
		return ok(
			[...files.keys()].filter((path) => SPEC_PATH.test(path)).join("\n"),
		);
	}
	// The template arrives as one script of quoted heredocs.
	const script = command.match(/^sh '([^']+)'$/);
	if (script) {
		const text = files.get(script[1]) ?? "";
		const dir = text.match(/^cd '([^']+)'$/m)?.[1];
		for (const file of text.matchAll(
			/^cat > '([^']+)' <<'FACTORY_TEMPLATE_EOF'\n([\s\S]*?)\nFACTORY_TEMPLATE_EOF$/gm,
		)) {
			files.set(`${dir}/${file[1]}`, file[2]);
		}
		return ok();
	}
	const clean = command.match(/-C '([^']+)' clean -fdXq/);
	if (clean) {
		const rules = (files.get(`${clean[1]}/.gitignore`) ?? "")
			.split("\n")
			.filter((rule) => rule !== "" && !rule.startsWith("#"));
		for (const path of below(clean[1])) {
			const relative = path.slice(clean[1].length + 1);
			const ignored = rules.some((rule) =>
				rule.startsWith("/")
					? relative.startsWith(rule.slice(1))
					: `/${relative}`.includes(`/${rule}`),
			);
			if (ignored) files.delete(path);
		}
		return ok();
	}
	// As for a first commit: the commit changes every file of the clone.
	if (command.includes(" diff-tree ")) {
		return ok(
			below(factoryConfig.repoDir)
				.map((path) => `${path.slice(factoryConfig.repoDir.length + 1)}\0`)
				.join(""),
		);
	}
	if (command.includes("%{http_code}")) return ok('200\n[{"id":1}]');
	return ok();
}

function filesystem(sandbox: Sandbox): Map<string, string> {
	const files = filesystems.get(sandbox);
	if (!files) throw new Error(`${sandbox.id} is not a fake sandbox`);
	return files;
}

/** The apps repository, as each push clones it. */
let repo: Map<string, string>;
let cloneSandbox: Sandbox;
/** The files of each pushed commit, in order. */
let pushes: Map<string, string>[];
/** The run's sandbox: the agents and verify-app work in it. */
let buildFiles: Map<string, string>;
let runSandbox: Sandbox;

function useRepo(entries: [string, string][]): void {
	repo = new Map(entries);
	cloneSandbox = fakeSandbox("sbx-clone", repo);
	mocks.createSandbox.mockResolvedValue(cloneSandbox);
}

function useRunSandbox(entries: [string, string][] = [], answer?: Answer) {
	buildFiles = new Map(entries);
	runSandbox = fakeSandbox("sbx-build", buildFiles, answer);
}

/** The builder writes the app into the run's sandbox and describes it. */
async function builderOutput(manifest: Manifest) {
	buildFiles.set(APP_SOURCE, STOREFRONT_HTML);
	return { summary: "A storefront for handmade walnut furniture.", manifest };
}

function builderReturns(manifest: Manifest): void {
	mocks.buildTask.mockImplementation(() => builderOutput(manifest));
}

interface Deploy {
	id: string;
	status: string;
}
/** Render's deploys of each service, oldest first. */
let deploys: Map<string, Deploy[]>;
/** The deploy Render creates for a service while a wait ignores its newest. */
let nextDeploys: Map<string, Deploy>;
/** The deploy that each service's last wait ended with. */
let resultDeploys: Map<string, string>;

/** waitForDeploy() over the fake deploy history, honoring `after`. */
async function waitForFakeDeploy(
	serviceId: string,
	{ after }: { after: string | null },
): Promise<DeployOutcome> {
	const history = deploys.get(serviceId) ?? [
		{ id: `${serviceId}-live`, status: "live" },
	];
	deploys.set(serviceId, history);
	let newest = history[history.length - 1];
	if (newest.id === after) {
		const next = nextDeploys.get(serviceId);
		if (!next) {
			return {
				deployId: newest.id,
				status: newest.status,
				result: "not_started",
			};
		}
		nextDeploys.delete(serviceId);
		history.push(next);
		newest = next;
	}
	resultDeploys.set(serviceId, newest.id);
	return {
		deployId: newest.id,
		status: newest.status,
		result: newest.status === "live" ? "live" : "failed",
	};
}

const BLUEPRINT = {
	id: "exs-test",
	name: "factory",
	status: "synced",
	autoSync: true,
	repo: "https://github.com/acme/apps",
	branch: "main",
	path: "render.yaml",
};

beforeEach(() => {
	vi.resetAllMocks();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.stubEnv("APPS_REPO", "acme/apps");
	vi.stubEnv("RENDER_WORKSPACE_ID", "tea-test");

	ran = [];
	pushes = [];
	deploys = new Map();
	nextDeploys = new Map();
	resultDeploys = new Map();
	useRepo([]);
	useRunSandbox();

	mocks.connectSandbox.mockImplementation(() => runSandbox);
	mocks.readAppFiles.mockImplementation(
		async (sandbox: Sandbox, appDir: string) => ({
			files: [...filesystem(sandbox)]
				.filter(([path]) => path.startsWith(`${appDir}/`))
				.map(([path, contents]) => ({
					path: path.slice(appDir.length + 1),
					data: Buffer.from(contents),
					executable: false,
				})),
		}),
	);
	mocks.writeAppFiles.mockImplementation(
		async (sandbox: Sandbox, appDir: string, copied: AppFile[]) => {
			const target = filesystem(sandbox);
			for (const path of [...target.keys()]) {
				if (path.startsWith(`${appDir}/`)) target.delete(path);
			}
			for (const { path, data } of copied) {
				target.set(`${appDir}/${path}`, data.toString());
			}
		},
	);

	// As git does: no commit when nothing changed since the last one.
	let head = new Map<string, string>();
	mocks.commitPaths.mockImplementation(async () => {
		if (
			head.size === repo.size &&
			[...repo].every(([path, contents]) => head.get(path) === contents)
		) {
			return null;
		}
		head = new Map(repo);
		return SHA;
	});
	mocks.pushVerified.mockImplementation(async () => {
		pushes.push(new Map(repo));
		return SHA;
	});
	mocks.githubToken.mockResolvedValue("ghs_test");
	mocks.cloneAppsRepo.mockResolvedValue("https://github.com/acme/apps.git");

	mocks.findBlueprint.mockResolvedValue(BLUEPRINT);
	mocks.waitForServices.mockImplementation(
		async (_workspaceId: string, names: string[]) =>
			new Map(
				names.map((name) => [
					name,
					{ id: `srv-${name}`, name, url: `https://${name}.onrender.com` },
				]),
			),
	);
	mocks.waitForDeploy.mockImplementation(waitForFakeDeploy);
	mocks.fetchDeployLogs.mockResolvedValue(
		'npm error Missing script: "migrate"',
	);
	mocks.waitForHttpOk.mockResolvedValue({
		ok: true,
		status: 200,
		body: '[{"id":1}]',
		headers: new Headers({ "access-control-allow-origin": "*" }),
	});
	mocks.pageContains.mockResolvedValue(true);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

/* ── prompt-to-app ────────────────────────────────────────────────────── */

describe("uniqueAppName", () => {
	it("gives two runs of the same name different apps, and keeps the suffix in every resource name", () => {
		const first = uniqueAppName("bakery", "3f2a9c1e-0000-4000-8000-000000000000");
		const second = uniqueAppName("bakery", "b81d0f77-0000-4000-8000-000000000000");
		expect(first).toBe("bakery-3f2a");
		expect(second).toBe("bakery-b81d");

		const long = uniqueAppName(
			"neighborhood-sourdough-bakery",
			"3f2a9c1e-0000-4000-8000-000000000000",
		);
		expect(long).toBe("neighborhood-sourdo-3f2a");
		expect(slug.safeParse(long).success).toBe(true);
		expect(
			resourceStem({ resourcePrefix: "vibe", user: "demo", appName: long }),
		).toMatch(/-3f2a$/);
	});
});

describe("promptToApp", () => {
	beforeEach(() => {
		mocks.architectTask.mockResolvedValue(plan("static_site"));
		builderReturns(siteOnly);
		// The run's sandbox first, then one for each push.
		mocks.createSandbox.mockResolvedValueOnce(runSandbox);
	});

	it("turns a static-site prompt into a deployed app with its URL, and terminates the sandbox", async () => {
		const result = await promptToApp.func(tasks, INPUT);

		expect(result).toMatchObject({
			status: "deployed",
			webUrl: expect.stringMatching(/demo-shop-run1-web\.onrender\.com$/),
		});
		expect(mocks.finishRun).toHaveBeenCalledWith(
			"run-1",
			"deployed",
			expect.anything(),
		);
		expect(subtasks()).toEqual([
			"architect",
			"builder",
			"verify-app",
			"publish-app",
		]);
		expect(pushes).toHaveLength(1);
		expect(pushes[0].get(APP_SOURCE)).toBe(STOREFRONT_HTML);
		expect(JSON.parse(pushes[0].get(APP_SPEC) ?? "").manifest).toEqual(
			siteOnly,
		);
		expect(runSandbox.terminate).toHaveBeenCalled();
	});

	it("starts a plan with a web service from the fullstack template and a sandbox Postgres", async () => {
		mocks.architectTask.mockResolvedValue(
			plan("static_site", "web_service", "postgres"),
		);
		let startedWith: string[] = [];
		mocks.buildTask.mockImplementation(() => {
			startedWith = [...buildFiles.keys()];
			return builderOutput(fullstack);
		});

		const result = await promptToApp.func(tasks, INPUT);

		expect(result).toMatchObject({
			status: "deployed",
			apiUrl: expect.stringMatching(/demo-shop-run1-api\.onrender\.com$/),
		});
		expect(startedWith).toEqual(
			expect.arrayContaining([
				`${APP_DIR}/api/package.json`,
				`${APP_DIR}/web/package.json`,
			]),
		);
		const verified = ran.find(({ name }) => name === "verify-app");
		expect(verified?.input).toMatchObject({
			databaseUrl: expect.stringMatching(/^postgres/),
		});
	});

	it("sends a verification failure back to the builder and deploys the fixed build", async () => {
		mocks.buildTask.mockImplementationOnce(() => builderOutput(privateHost));

		const result = await promptToApp.func(tasks, INPUT);

		expect(result.status, result.summary).toBe("deployed");
		expect(subtasks()).toEqual([
			"architect",
			"builder",
			"verify-app",
			"builder",
			"verify-app",
			"publish-app",
		]);
		expect(mocks.buildTask.mock.calls[1][1].message).toMatch(/private network/);
		expect(pushes).toHaveLength(1);
		expect(JSON.parse(pushes[0].get(APP_SPEC) ?? "").manifest).toEqual(
			siteOnly,
		);
	});

	it("ends as build_failed, with nothing pushed, when verification still fails after the last fix round", async () => {
		builderReturns(privateHost);

		const result = await promptToApp.func(tasks, INPUT);

		expect(result.status).toBe("build_failed");
		expect(result.summary).toMatch(/private network/);
		expect(subtasks()).toEqual([
			"architect",
			"builder",
			"verify-app",
			"builder",
			"verify-app",
			"builder",
			"verify-app",
		]);
		expect(pushes).toEqual([]);
		expect(runSandbox.terminate).toHaveBeenCalled();
	});

	it("fails the run, with no sandbox and no push, when the architect's output fails the schema twice", async () => {
		mocks.architectTask.mockResolvedValue({ appName: "Not A Slug" });

		await expect(promptToApp.func(tasks, INPUT)).rejects.toThrow(
			/invalid structured output twice/,
		);

		expect(mocks.finishRun).toHaveBeenCalledWith("run-1", "failed", {
			summary: expect.stringMatching(/^architect returned invalid/),
		});
		expect(mocks.createSandbox).not.toHaveBeenCalled();
		expect(pushes).toEqual([]);
	});

	it("fails the run before any build or push when the app is being deleted or built by another run", async () => {
		const refusals = [
			["deleting", /demo\/shop-run1 is being deleted/],
			["running", /different run is building demo\/shop-run1/],
		] as const;
		for (const [reason, summary] of refusals) {
			mocks.claimRunApp.mockResolvedValueOnce({ claimed: false, reason });

			const result = await promptToApp.func(tasks, INPUT);

			expect(result.status).toBe("failed");
			expect(result.summary).toMatch(summary);
		}
		expect(mocks.createSandbox).not.toHaveBeenCalled();
		expect(mocks.buildTask).not.toHaveBeenCalled();
		expect(pushes).toEqual([]);
	});

	it("ends as awaiting_blueprint after the push when no Blueprint watches the apps repository", async () => {
		mocks.findBlueprint.mockResolvedValue(null);

		const result = await promptToApp.func(tasks, INPUT);

		expect(result.status).toBe("awaiting_blueprint");
		expect(result.summary).toMatch(/no Blueprint .* is watching/);
		expect(pushes).toHaveLength(1);
		expect(mocks.waitForServices).not.toHaveBeenCalled();
	});

	// The builder can run any command in the run's sandbox and leave a
	// process there, so no credential and no clone may ever enter it.
	it("keeps the GitHub token out of the run's sandbox and pushes only the app's directory and the root Blueprint from a separate clone", async () => {
		const token = "ghs_push_token";
		mocks.githubToken.mockResolvedValue(token);
		const victimDir = appPath("victim", "site");
		useRepo([
			[
				`${victimDir}/factory.json`,
				json({ ...spec, user: "victim", appName: "site" }),
			],
			[`${victimDir}/index.html`, STOREFRONT_HTML],
		]);
		const before = new Map(repo);
		mocks.buildTask.mockImplementation(() => {
			buildFiles.set(APP_SPEC, json({ ...spec, appName: "evil" }));
			buildFiles.set(`${victimDir}/index.html`, "defaced");
			return builderOutput(siteOnly);
		});

		await promptToApp.func(tasks, INPUT);

		const commands = vi.mocked(runSandbox.run).mock.calls.join("\n");
		expect(commands).not.toMatch(/ghs_|clone|remote/);
		expect(JSON.stringify([...buildFiles])).not.toContain(token);
		expect(JSON.stringify(ran)).not.toContain(token);
		expect(mocks.cloneAppsRepo.mock.calls.map(([sandbox]) => sandbox)).toEqual([
			cloneSandbox,
		]);
		expect(mocks.pushVerified).toHaveBeenCalledWith(
			cloneSandbox,
			token,
			expect.any(String),
			factoryConfig.branch,
			[`apps/demo/${APP_NAME}`, factoryConfig.blueprintPath],
			expect.any(Function),
		);

		const [commit] = pushes;
		const changed = [...commit.keys()].filter(
			(path) => commit.get(path) !== before.get(path),
		);
		expect(
			changed.filter(
				(path) => path !== ROOT_BLUEPRINT && !path.startsWith(`${APP_DIR}/`),
			),
		).toEqual([]);
		expect(commit.get(`${victimDir}/index.html`)).toBe(STOREFRONT_HTML);
		expect(JSON.parse(commit.get(APP_SPEC) ?? "")).toMatchObject({
			user: "demo",
			appName: APP_NAME,
			manifest: siteOnly,
		});
		expect(commit.get(ROOT_BLUEPRINT)).not.toMatch(/demo-evil/);
	});
});

/* ── The deploy stage ─────────────────────────────────────────────────── */

describe("awaitDeployment", () => {
	/** A repair that changes only how the API migrates. */
	const repair: Manifest = {
		...fullstack,
		services: [
			fullstack.services[0],
			{ ...api, preDeployCommand: "npm run db:migrate" },
		],
	};

	/** The deploy stage after the first push of the shop app. */
	function deploy(
		push: Partial<
			Pick<DeployContext, "deploysBefore" | "changedServices">
		> = {},
	) {
		return awaitDeployment({
			tasks,
			sandbox: runSandbox,
			workspaceId: "tea-test",
			repoUrl: "https://github.com/acme/apps",
			spec,
			appDir: APP_DIR,
			runId: "run-1",
			summary: "Handmade walnut furniture, sold online.",
			databaseUrl: null,
			deploysBefore: new Map(),
			changedServices: ["web", "api"],
			...push,
		});
	}

	/** The API's first deploy fails its pre-deploy command. */
	function apiDeployFails(): void {
		deploys.set(API_ID, [{ id: "dep-api1", status: "pre_deploy_failed" }]);
	}

	beforeEach(() => {
		useRepo([[APP_SPEC, json(spec)]]);
		useRunSandbox([
			[APP_SOURCE, STOREFRONT_HTML],
			[`${APP_DIR}/api/src/index.ts`, "export {};"],
		]);
		builderReturns(repair);
	});

	it("repairs a failed deploy from its logs through verify-app and publish-app, and ends deployed when the new deploy is live", async () => {
		apiDeployFails();
		nextDeploys.set(API_ID, { id: "dep-api2", status: "live" });
		mocks.fetchDeployLogs.mockResolvedValue(
			"DATABASE_URL=postgres://shop:s3cret@dpg-shop-a/shop\nnpm error Missing script",
		);

		const result = await deploy();

		expect(result.status, result.summary).toBe("deployed");
		expect(subtasks()).toEqual(["builder", "verify-app", "publish-app"]);
		// The Dashboard shows every task input, so the logs arrive redacted.
		const repairInput = JSON.stringify(ran[0].input);
		expect(repairInput).toContain("npm error Missing script");
		expect(repairInput).toContain("[REDACTED]");
		expect(repairInput).not.toContain("s3cret");
		expect(pushes).toHaveLength(1);
		expect(JSON.parse(pushes[0].get(APP_SPEC) ?? "")).toEqual({
			...spec,
			manifest: repair,
		});
	});

	it("pushes nothing and ends deploy_failed when a repair adds a resource", async () => {
		apiDeployFails();
		builderReturns({
			...repair,
			services: [
				...repair.services,
				{ ...api, name: "search", rootDir: "search" },
			],
		});

		const result = await deploy();

		expect(result.status).toBe("deploy_failed");
		expect(result.summary).toMatch(/was not pushed\. The repair adds/);
		expect(pushes).toEqual([]);
	});

	it("ends deploy_failed when the repair push starts no new deploy, even though an old deploy is live", async () => {
		apiDeployFails();

		const result = await deploy();

		expect(result.status).toBe("deploy_failed");
		expect(result.summary).toMatch(/repair push did not start a new deploy/);
		expect(pushes).toHaveLength(1);
		expect(mocks.waitForHttpOk).not.toHaveBeenCalled();
	});

	it("on a rebuild, waits past the pre-push deploy of each changed service and keeps the live deploy of an unchanged one", async () => {
		deploys.set(WEB_ID, [{ id: "dep-web0", status: "live" }]);
		deploys.set(API_ID, [{ id: "dep-api0", status: "live" }]);
		nextDeploys.set(API_ID, { id: "dep-api1", status: "live" });

		const result = await deploy({
			deploysBefore: new Map([
				["acme-demo-shop-run1-web", "dep-web0"],
				["acme-demo-shop-run1-api", "dep-api0"],
			]),
			changedServices: ["api"],
		});

		expect(result.status, result.summary).toBe("deployed");
		expect(Object.fromEntries(resultDeploys)).toEqual({
			[WEB_ID]: "dep-web0",
			[API_ID]: "dep-api1",
		});
	});

	it("ends deploy_failed when a browser could not use the live app: no API hostname in the storefront, or no CORS header for its origin", async () => {
		mocks.pageContains.mockResolvedValue(false);

		const noHost = await deploy();

		expect(noHost.status).toBe("deploy_failed");
		expect(noHost.summary).toMatch(/does not contain the API hostname/);

		mocks.pageContains.mockResolvedValue(true);
		mocks.waitForHttpOk.mockResolvedValue({
			ok: true,
			status: 200,
			body: '[{"id":1}]',
			headers: new Headers(),
		});

		const noCors = await deploy();

		expect(noCors.status).toBe("deploy_failed");
		expect(noCors.summary).toMatch(/no access-control-allow-origin header/);
	});
});

/* ── verify-app ───────────────────────────────────────────────────────── */

describe("verifyAppTask", () => {
	const DATABASE_URL = "postgres://app:app@127.0.0.1:5432/appdb";

	function verify(manifest: Manifest, databaseUrl: string | null = null) {
		return verifyAppTask.func(tasks, {
			sandboxId: runSandbox.id,
			user: "demo",
			appName: APP_NAME,
			manifest,
			databaseUrl,
		});
	}

	const apiOnly: Manifest = { services: [api], databases: [{ name: "db" }] };
	const apiSource: [string, string][] = [
		[`${APP_DIR}/api/src/index.ts`, "export {};"],
	];

	it("fails a web service whose health check needs the database, or whose data endpoint returns no rows", async () => {
		useRunSandbox(apiSource, (command) =>
			command.includes("nohup") && command.includes("postgres://unreachable/db")
				? { output: "Error: connect ECONNREFUSED", exitCode: 1 }
				: undefined,
		);
		const needsDatabase = await verify(apiOnly, DATABASE_URL);

		useRunSandbox(apiSource, (command) =>
			command.includes("%{http_code}")
				? { output: "200\n[]", exitCode: 0 }
				: undefined,
		);
		const noRows = await verify(apiOnly, DATABASE_URL);

		expect(needsDatabase.failures).toEqual([
			expect.stringMatching(/\/health did not answer .* unreachable database/),
		]);
		expect(noRows.failures).toEqual([
			expect.stringMatching(/\/api\/items returned 200 but no data/),
		]);
	});

	it("fails a static site that takes a private-network property from another service", async () => {
		useRunSandbox([[APP_SOURCE, STOREFRONT_HTML]]);

		const { failures } = await verify(privateHost);

		expect(failures).toEqual([
			expect.stringMatching(/VITE_API_HOST .*private network/),
		]);
	});

	it("removes the files the app's .gitignore ignores before the build, so a build that needs one fails", async () => {
		useRunSandbox([
			[APP_SOURCE, STOREFRONT_HTML],
			[`${APP_DIR}/web/node_modules/.bin/vite`, "#!/bin/sh"],
		]);

		const { failures } = await verify({
			services: [
				{ ...storefront, buildCommand: "test -f node_modules/.bin/vite" },
			],
		});

		expect(failures).toEqual([
			expect.stringMatching(/^web \(web\) build failed/),
		]);
		expect([...buildFiles.keys()]).toEqual([
			APP_SOURCE,
			`${APP_DIR}/.gitignore`,
		]);
	});
});

/* ── delete-app ───────────────────────────────────────────────────────── */

describe("deleteApp", () => {
	const SHOP_RESOURCES = [
		"acme-demo-shop-run1-web",
		"acme-demo-shop-run1-api",
		"acme-demo-shop-run1-db",
	];

	beforeEach(() => {
		useRepo([
			[APP_SPEC, json(spec)],
			[APP_SOURCE, STOREFRONT_HTML],
			[CAFE_SPEC, json(cafe)],
		]);
		mocks.deleteAppResources.mockResolvedValue(SHOP_RESOURCES);
	});

	it("removes the app from the Blueprint, waits for syncs, deletes its resources, then removes its files and its runs", async () => {
		const result = await deleteApp.func(tasks, SHOP_APP);

		expect(result).toMatchObject({
			status: "deleted",
			deleted: SHOP_RESOURCES,
		});
		expect(subtasks()).toEqual([
			"remove-app-from-blueprint",
			"wait-for-blueprint-syncs",
			"delete-app-resources",
			"remove-app-files",
		]);
		const [leave, removal] = pushes;
		// A commit that removed the source would start a build of each service.
		expect(leave.get(APP_SOURCE)).toBe(STOREFRONT_HTML);
		expect(leave.get(ROOT_BLUEPRINT)).not.toMatch(/acme-demo-shop/);
		expect(leave.get(ROOT_BLUEPRINT)).toMatch(/acme-demo-cafe-web/);
		expect(
			[...removal.keys()].filter((path) => path.startsWith(`${APP_DIR}/`)),
		).toEqual([]);
		expect(removal.get(CAFE_SPEC)).toBe(json(cafe));
		expect(mocks.deleteRuns).toHaveBeenCalledWith("demo", APP_NAME);
	});

	it("deletes no Render resource when the repository has no spec for the app, and still removes its files", async () => {
		useRepo([
			[APP_SOURCE, STOREFRONT_HTML],
			[CAFE_SPEC, json(cafe)],
		]);

		const result = await deleteApp.func(tasks, SHOP_APP);

		expect(result).toMatchObject({ status: "deleted", deleted: [] });
		expect(subtasks()).toEqual([
			"remove-app-from-blueprint",
			"remove-app-files",
		]);
		expect(mocks.deleteAppResources).not.toHaveBeenCalled();
		expect(repo.has(APP_SOURCE)).toBe(false);
	});

	it("marks the app delete_failed, and keeps its runs and files, when a step fails", async () => {
		mocks.deleteAppResources.mockRejectedValue(
			new Error("Render did not delete acme-demo-shop-run1-db (403)"),
		);

		await expect(deleteApp.func(tasks, SHOP_APP)).rejects.toThrow("(403)");

		expect(mocks.failDelete).toHaveBeenCalledWith(
			"demo",
			APP_NAME,
			expect.stringMatching(/\(403\)/),
		);
		expect(mocks.deleteRuns).not.toHaveBeenCalled();
		expect(subtasks()).not.toContain("remove-app-files");
		expect(repo.get(APP_SOURCE)).toBe(STOREFRONT_HTML);
	});
});

/* ── Retries ──────────────────────────────────────────────────────────── */

// AGENTS.md, Durability: a retry of any of these repeats a side effect or
// hides a failure, so a failure is final and a caller starts again.
it("registers prompt-to-app, verify-app, publish-app, delete-app, and each delete step with retries off", () => {
	const definitions = [
		promptToApp,
		verifyAppTask,
		publishAppTask,
		deleteApp,
		removeFromBlueprintTask,
		waitForSyncsTask,
		deleteResourcesTask,
		removeFilesTask,
	];
	for (const { name } of definitions) {
		expect(
			TaskRegistry.getInstance().get(name)?.options?.retry?.max_retries,
			name,
		).toBe(0);
	}
});
