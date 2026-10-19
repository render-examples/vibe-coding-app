/**
 * The Render reads of the workflow. No test calls the Render API: each test
 * replaces fetch, and a fake clock runs the waits between polls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	fetchDeployLogs,
	findBlueprint,
	latestDeploys,
	pageContains,
	retryRead,
	waitForDeploy,
} from "../app/render.js";

interface Deploy {
	id: string;
	status: string;
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

/** Answer each request with the next response; repeat the last one. */
function renderAnswers(...responses: (() => Response)[]) {
	let calls = 0;
	const fetchMock = vi.fn(async (_url: string | URL | Request) =>
		responses[Math.min(calls++, responses.length - 1)](),
	);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

const deploys =
	(...list: Deploy[]) =>
	() =>
		Response.json(list.map((deploy) => ({ deploy, cursor: "c" })));

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubEnv("RENDER_API_KEY", "rnd_test");
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

/**
 * Right after a push, the newest deploy is still the deploy from before the
 * push, so every wait after a push names that deploy as `after`.
 */
describe("waitForDeploy", () => {
	it("returns failed when the newest deploy fails", async () => {
		renderAnswers(
			deploys({ id: "dep-1", status: "build_in_progress" }),
			deploys({ id: "dep-1", status: "pre_deploy_failed" }),
		);

		expect(
			await settle(waitForDeploy("srv-api", { timeoutMs: 60_000 })),
		).toEqual({
			deployId: "dep-1",
			status: "pre_deploy_failed",
			result: "failed",
		});
	});

	it("ignores the deploy from before the push and waits for a newer one to go live", async () => {
		renderAnswers(
			deploys({ id: "dep-1", status: "pre_deploy_failed" }),
			deploys({ id: "dep-2", status: "build_in_progress" }),
			deploys({ id: "dep-2", status: "live" }),
		);

		expect(
			await settle(
				waitForDeploy("srv-api", { timeoutMs: 60_000, after: "dep-1" }),
			),
		).toEqual({ deployId: "dep-2", status: "live", result: "live" });
	});

	// Render keeps the last live deploy of a failed service, so the old deploy
	// is never the push's result, not even when it is live.
	it("returns not_started when no newer deploy starts before the deadline", async () => {
		renderAnswers(deploys({ id: "dep-1", status: "live" }));

		expect(
			await settle(
				waitForDeploy("srv-api", { timeoutMs: 60_000, after: "dep-1" }),
			),
		).toMatchObject({ deployId: "dep-1", result: "not_started" });
	});
});

describe("latestDeploys", () => {
	it("returns the newest deploy of each service that exists and has one", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL | Request) => {
				const { pathname } = new URL(String(url));
				if (pathname === "/v1/services") {
					// The API's name filter is not the check.
					return Response.json(
						[
							{ id: "srv-web", name: "vibe-demo-shop-web" },
							{ id: "srv-api", name: "vibe-demo-shop-api" },
							{ id: "srv-api2", name: "vibe-demo-shop-api-2" },
						].map((service) => ({ service, cursor: "c" })),
					);
				}
				if (pathname === "/v1/services/srv-web/deploys") {
					return deploys({ id: "dep-web0", status: "live" })();
				}
				if (pathname === "/v1/services/srv-api2/deploys") {
					return deploys({ id: "dep-other", status: "live" })();
				}
				return deploys()();
			}),
		);

		expect(
			await settle(
				latestDeploys("tea-test", [
					"vibe-demo-shop-web",
					"vibe-demo-shop-api",
					"vibe-demo-shop-db-reader",
				]),
			),
		).toEqual(new Map([["vibe-demo-shop-web", "dep-web0"]]));
	});
});

describe("retryRead", () => {
	it("retries a transient failure, and gives up after five failures in a row", async () => {
		const flaky = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(new TypeError("fetch failed"))
			.mockRejectedValueOnce(new Error("503"))
			.mockResolvedValue("ok");
		expect(await settle(retryRead("The lookup", flaky))).toBe("ok");

		const broken = vi.fn(async () => {
			throw new Error("upstream error");
		});
		await expect(settle(retryRead("The lookup", broken))).rejects.toThrow(
			"failed 5 times in sequence",
		);
		expect(broken).toHaveBeenCalledTimes(5);
	});
});

describe("findBlueprint", () => {
	const target = {
		workspaceId: "tea-factory",
		repo: "https://github.com/acme/apps",
		branch: "main",
		path: "render.yaml",
	};
	const ours = {
		id: "exs-ours",
		name: "apps",
		status: "in_sync",
		autoSync: true,
		repo: "https://github.com/acme/apps.git",
		branch: "main",
		path: "render.yaml",
	};
	const other = (n: number) => ({
		blueprint: { ...ours, id: `exs-${n}`, repo: `https://github.com/x/${n}` },
		cursor: `cursor-${n}`,
	});
	const fullPage = () =>
		Response.json(Array.from({ length: 100 }, (_, n) => other(n)));

	// Null makes the run tell the user to create a Blueprint. A refused lookup
	// is not proof that none exists, and a new attempt cannot repair the API
	// key, so a 401 or 403 fails at once.
	it("pages through the Blueprints, and returns null only when none matches", async () => {
		renderAnswers(fullPage, () =>
			Response.json([other(100), { blueprint: ours, cursor: "c" }]),
		);
		expect(await settle(findBlueprint(target))).toEqual(ours);

		renderAnswers(fullPage, () => Response.json([other(100)]));
		expect(await settle(findBlueprint(target))).toBeNull();

		for (const status of [401, 403]) {
			const fetchMock = renderAnswers(() => new Response("", { status }));
			await expect(settle(findBlueprint(target))).rejects.toThrow(
				`failed with ${status}`,
			);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		}
	});
});

describe("pageContains", () => {
	const PAGE = "https://vibe-demo-shop-web.onrender.com";
	const API_HOST = "vibe-demo-shop-api.onrender.com";

	// An agent wrote the page, and it must not send the workflow to other hosts.
	it("finds text in a same-origin script and never fetches another origin", async () => {
		const files: Record<string, string> = {
			[PAGE]: [
				'<script src="https://cdn.example.com/lib.js"></script>',
				'<script type="module" src="/assets/index-B1x2.js"></script>',
			].join(""),
			[`${PAGE}/assets/index-B1x2.js`]: `const b="https://${API_HOST}";`,
		};
		const fetchMock = vi.fn(async (url: string | URL | Request) => {
			const body = files[String(url)];
			return body === undefined
				? new Response("not found", { status: 404 })
				: new Response(body);
		});
		vi.stubGlobal("fetch", fetchMock);

		expect(await pageContains(PAGE, API_HOST)).toBe(true);
		expect(await pageContains(PAGE, "vibe-demo-shop-api-x7k2:10000")).toBe(
			false,
		);
		for (const [url] of fetchMock.mock.calls) {
			expect(new URL(String(url)).origin).toBe(PAGE);
		}
	});
});

describe("fetchDeployLogs", () => {
	// The logs are only diagnostic. A read that cannot finish must not end a
	// run that a repair can still fix.
	it("returns no logs instead of failing when the reads fail", async () => {
		renderAnswers(() => new Response("", { status: 503 }));

		expect(
			await settle(fetchDeployLogs("srv-api", "dep-api2", "tea-test")),
		).toBe("");
	});
});
