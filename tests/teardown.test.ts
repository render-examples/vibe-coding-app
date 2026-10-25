/**
 * app/teardown.ts makes the factory's only Render write calls. These tests
 * pin down that it deletes only in the app's own project, and that it waits
 * until no sync of an earlier commit can bring a resource back. A fake fetch
 * holds the workspace, and a fake clock runs the waits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteAppResources, waitForBlueprintSyncs } from "../app/teardown.js";

const APP = { user: "demo", appName: "shop", resourcePrefix: "vibe" };
const OPTIONS = { workspaceId: "tea-test" };

interface Named {
	id: string;
	name: string;
}

interface Workspace {
	projects: (Named & { environmentIds: string[] })[];
	services: Record<string, Named[]>;
	postgres: Record<string, Named[]>;
	/** The status each DELETE path answers; 204 otherwise. */
	deleteStatus: Record<string, number>;
	/** GET .../syncs answers these states in order, then repeats the last. */
	syncStates: string[];
	/** The next GETs of each path answer 500, this many times. */
	readFailures: Record<string, number>;
}

let workspace: Workspace;
/** Each DELETE path, in order. */
let deleted: string[];
let syncReads: number;

function serve(): void {
	deleted = [];
	syncReads = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			const path = url.pathname.replace(/^\/v1/, "");
			if (init?.method === "DELETE") {
				deleted.push(path);
				const status = workspace.deleteStatus[path] ?? 204;
				return new Response(status === 204 ? null : "refused", { status });
			}
			if (workspace.readFailures[path] > 0) {
				workspace.readFailures[path]--;
				return new Response("unavailable", { status: 500 });
			}
			const environment = url.searchParams.get("environmentId") ?? "";
			const page = (key: string, items: unknown[]) =>
				Response.json(items.map((item) => ({ [key]: item, cursor: "c" })));
			switch (path) {
				case "/blueprints/exs-apps/syncs": {
					const states = workspace.syncStates;
					const state = states[Math.min(syncReads++, states.length - 1)];
					return page("sync", [{ commit: { id: "c1abcdef" }, state }]);
				}
				// A prefix match, as the API's name filter is.
				case "/projects":
					return page(
						"project",
						workspace.projects.filter((project) =>
							project.name.startsWith(url.searchParams.get("name") ?? ""),
						),
					);
				case "/services":
					return page("service", workspace.services[environment] ?? []);
				case "/postgres":
					return page("postgres", workspace.postgres[environment] ?? []);
				default:
					return new Response("not found", { status: 404 });
			}
		}),
	);
}

/** Run the fake clock until the promise settles. */
async function settle<T>(promise: Promise<T>): Promise<T> {
	let done = false;
	const tracked = promise.finally(() => {
		done = true;
	});
	// The caller gets the rejection. This handler only stops a warning.
	tracked.catch(() => {});
	while (!done) await vi.advanceTimersByTimeAsync(5_000);
	return tracked;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.stubEnv("RENDER_API_KEY", "rnd_test");
	workspace = {
		projects: [
			{ id: "prj-shop", name: "vibe-demo-shop", environmentIds: ["evm-shop"] },
			// App "shop-v2" has a project name that starts with app "shop"'s.
			{ id: "prj-v2", name: "vibe-demo-shop-v2", environmentIds: ["evm-v2"] },
		],
		services: {
			"evm-shop": [
				{ id: "srv-web", name: "vibe-demo-shop-web" },
				{ id: "srv-api", name: "vibe-demo-shop-api" },
			],
			"evm-v2": [{ id: "srv-v2", name: "vibe-demo-shop-v2-web" }],
		},
		postgres: { "evm-shop": [{ id: "dpg-db", name: "vibe-demo-shop-db" }] },
		deleteStatus: {},
		syncStates: ["success"],
		readFailures: {},
	};
	serve();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("deleteAppResources", () => {
	it("deletes only the app's own project and resources: services, then databases, then the project", async () => {
		expect(await settle(deleteAppResources(APP, OPTIONS))).toEqual([
			"vibe-demo-shop-web",
			"vibe-demo-shop-api",
			"vibe-demo-shop-db",
		]);
		expect(deleted).toEqual([
			"/services/srv-web",
			"/services/srv-api",
			"/postgres/dpg-db",
			"/projects/prj-shop",
		]);
	});

	it("keeps a resource the factory did not name, and fails without deleting the project", async () => {
		workspace.services["evm-shop"].push({ id: "srv-grafana", name: "grafana" });

		await expect(settle(deleteAppResources(APP, OPTIONS))).rejects.toThrow(
			"also holds grafana",
		);
		expect(deleted).not.toContain("/services/srv-grafana");
		expect(deleted).not.toContain("/projects/prj-shop");
	});

	// A new attempt of a delete finds what an earlier attempt deleted.
	it("counts a resource that is already gone as deleted", async () => {
		workspace.deleteStatus["/services/srv-web"] = 404;

		expect(await settle(deleteAppResources(APP, OPTIONS))).toContain(
			"vibe-demo-shop-web",
		);
		expect(deleted).toContain("/projects/prj-shop");
	});

	// One failed read must not end the delete as delete_failed.
	it("reads the projects and resources again after a temporary failure", async () => {
		workspace.readFailures = { "/projects": 1, "/services": 1 };

		expect(await settle(deleteAppResources(APP, OPTIONS))).toEqual([
			"vibe-demo-shop-web",
			"vibe-demo-shop-api",
			"vibe-demo-shop-db",
		]);
	});
});

/**
 * From the delete's commit on, the Blueprint does not declare the app, so
 * only an unfinished sync of an earlier commit can bring a resource back.
 */
describe("waitForBlueprintSyncs", () => {
	it("waits until no sync is pending or running", async () => {
		workspace.syncStates = ["pending", "running", "success"];

		await settle(
			waitForBlueprintSyncs("exs-apps", { pushedAt: null, timeoutMs: 60_000 }),
		);

		expect(syncReads).toBe(3);
	});

	it("fails when a sync does not finish before its timeout", async () => {
		workspace.syncStates = ["running"];

		await expect(
			settle(
				waitForBlueprintSyncs("exs-apps", {
					pushedAt: null,
					timeoutMs: 60_000,
				}),
			),
		).rejects.toThrow("did not finish");
	});
});
