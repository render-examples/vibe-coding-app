/**
 * The gateway through its HTTP API. Postgres (the store module) and Render
 * Workflows (the SDK) are the boundaries, and both are fakes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	claimDelete: vi.fn(),
	claimRun: vi.fn(),
	claimWorkflowCheck: vi.fn(),
	deleteRunWithoutApp: vi.fn(),
	failDelete: vi.fn(),
	finishRun: vi.fn(),
	getRun: vi.fn(),
	listRunsByUser: vi.fn(),
	ping: vi.fn(),
	setDeleteWorkflowRunId: vi.fn(),
	setWorkflowRunId: vi.fn(),
	startTask: vi.fn(),
	getTaskRun: vi.fn(),
	workflowIdOfTaskRun: vi.fn(),
}));

vi.mock("../app/store.js", () => ({
	claimDelete: mocks.claimDelete,
	claimRun: mocks.claimRun,
	claimWorkflowCheck: mocks.claimWorkflowCheck,
	deleteRunWithoutApp: mocks.deleteRunWithoutApp,
	failDelete: mocks.failDelete,
	finishRun: mocks.finishRun,
	getRun: mocks.getRun,
	listRunsByUser: mocks.listRunsByUser,
	ping: mocks.ping,
	setDeleteWorkflowRunId: mocks.setDeleteWorkflowRunId,
	setWorkflowRunId: mocks.setWorkflowRunId,
}));

vi.mock("../app/render.js", () => ({
	workflowIdOfTaskRun: mocks.workflowIdOfTaskRun,
}));

vi.mock("@renderinc/sdk", () => ({
	Render: class {
		workflows = {
			startTask: mocks.startTask,
			getTaskRun: mocks.getTaskRun,
		};
	},
}));

const { createGateway } = await import("../app/gateway.js");
const { RUN_STAGES } =
	await vi.importActual<typeof import("../app/store.js")>("../app/store.js");

const KEY = "0123456789abcdef0123456789abcdef";
const PROMPT = "Create an online catalog to sell handcrafted furniture";
const RUN_ID = "6f9619ff-8b86-d011-b42d-00cf4fc964ff";
const UI_AUTH = `Basic ${Buffer.from("demo:a-long-demo-password").toString("base64")}`;
const BEARER = `Bearer ${KEY}`;

function request(
	path: string,
	init: { method?: string; authorization?: string; body?: unknown } = {},
) {
	const headers: Record<string, string> = {};
	if (init.authorization) headers.authorization = init.authorization;
	if (init.body !== undefined) headers["content-type"] = "application/json";
	return createGateway().request(path, {
		method: init.method ?? "GET",
		headers,
		body:
			init.body === undefined || typeof init.body === "string"
				? init.body
				: JSON.stringify(init.body),
	});
}

const post = (body: unknown, authorization = BEARER) =>
	request("/v1/apps", { method: "POST", authorization, body });

/** A stored run of the furniture catalog, with some fields replaced. */
function storedRun(overrides: Record<string, unknown> = {}) {
	return {
		id: RUN_ID,
		idempotencyKey: "k",
		prompt: PROMPT,
		user: "demo",
		status: "deployed",
		stage: "done",
		progress: null,
		stageHistory: [],
		workflowRunId: "trn-1",
		appName: "furniture-catalog",
		webUrl: "https://vibe-demo-furniture-catalog-web.onrender.com",
		apiUrl: null,
		blueprintPath: "apps/demo/furniture-catalog/render.yaml",
		summary: "Deployed.",
		sandboxId: null,
		sandboxGroupId: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:10:00.000Z",
		finishedAt: "2026-01-01T00:09:00.000Z",
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.claimRun.mockResolvedValue({ claimed: true });
	mocks.claimDelete.mockResolvedValue({ claimed: true, runIds: [RUN_ID] });
	mocks.claimWorkflowCheck.mockResolvedValue(true);
	mocks.deleteRunWithoutApp.mockResolvedValue(true);
	mocks.failDelete.mockResolvedValue(undefined);
	mocks.finishRun.mockResolvedValue(undefined);
	mocks.getRun.mockResolvedValue(storedRun());
	mocks.listRunsByUser.mockResolvedValue([]);
	mocks.ping.mockResolvedValue(undefined);
	mocks.setDeleteWorkflowRunId.mockResolvedValue(undefined);
	mocks.setWorkflowRunId.mockResolvedValue(undefined);
	mocks.startTask.mockResolvedValue({ taskRunId: "trn-1" });
	mocks.workflowIdOfTaskRun.mockResolvedValue("wfl-1");

	process.env.FACTORY_API_KEY = KEY;
	process.env.UI_USERNAME = "demo";
	process.env.UI_PASSWORD = "a-long-demo-password";
	process.env.RENDER_WORKFLOW_SLUG = "wfs-1";
	delete process.env.UI_AUTH_DISABLED;
	delete process.env.NODE_ENV;
	delete process.env.RENDER_USE_LOCAL_DEV;
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("health", () => {
	it("reports liveness without Postgres, and readiness as 503 when Postgres is down", async () => {
		mocks.ping.mockRejectedValue(new Error("down"));

		expect((await request("/health")).status).toBe(200);
		expect((await request("/ready")).status).toBe(503);
	});
});

describe("POST /v1/apps", () => {
	it("requires the bearer token on every /v1 route", async () => {
		expect((await post({ prompt: PROMPT }, "")).status).toBe(401);
		expect((await post({ prompt: PROMPT }, "Bearer wrong-token")).status).toBe(
			401,
		);
		expect((await request(`/v1/apps/${RUN_ID}`)).status).toBe(401);
		expect(mocks.claimRun).not.toHaveBeenCalled();
		expect(mocks.getRun).not.toHaveBeenCalled();
	});

	// Not JSON, so a body parsed before the cap would get 400.
	it("rejects a body over the size cap before parsing it", async () => {
		const response = await post("x".repeat(70 * 1024));

		expect(response.status).toBe(413);
		expect(mocks.claimRun).not.toHaveBeenCalled();
	});

	it("rejects an invalid prompt with 400 and starts nothing", async () => {
		const response = await post({ prompt: "hi" });

		expect(response.status).toBe(400);
		expect(mocks.claimRun).not.toHaveBeenCalled();
		expect(mocks.startTask).not.toHaveBeenCalled();
	});

	it("claims a valid prompt, dispatches prompt-to-app, and returns 202 with a status URL", async () => {
		const response = await post({ prompt: PROMPT, user: "demo" });
		const body = await response.json();

		expect(response.status).toBe(202);
		expect(body.statusUrl).toBe(`/v1/apps/${body.runId}`);
		expect(mocks.claimRun).toHaveBeenCalledWith(
			expect.objectContaining({ id: body.runId, prompt: PROMPT, user: "demo" }),
		);
		expect(mocks.startTask).toHaveBeenCalledWith("wfs-1/prompt-to-app", [
			{ prompt: PROMPT, user: "demo", runId: body.runId },
		]);
	});

	it("returns the existing run for a repeated idempotency key without dispatching", async () => {
		mocks.claimRun.mockResolvedValue({
			claimed: false,
			reason: "duplicate",
			runId: "run-1",
		});

		const response = await post({ prompt: PROMPT, idempotencyKey: "same-key-1" });

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			runId: "run-1",
			duplicate: true,
		});
		expect(mocks.startTask).not.toHaveBeenCalled();
	});

	it("returns 429 at capacity without dispatching", async () => {
		mocks.claimRun.mockResolvedValue({ claimed: false, reason: "at_capacity" });

		const response = await post({ prompt: PROMPT });

		expect(response.status).toBe(429);
		expect(mocks.startTask).not.toHaveBeenCalled();
	});

	it("releases the claim and returns 502 when the dispatch fails", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.startTask.mockRejectedValue(new Error("render unavailable"));

		const response = await post({ prompt: PROMPT });

		expect(response.status).toBe(502);
		const [{ id }] = mocks.claimRun.mock.calls[0];
		expect(mocks.finishRun).toHaveBeenCalledWith(
			id,
			"failed",
			expect.anything(),
		);
	});
});

describe("browser UI", () => {
	const pages = ["/", "/table", "/app.js", "/table.js", "/runs.js"];

	it("requires Basic Auth for every UI file and route, and serves no file that holds FACTORY_API_KEY", async () => {
		for (const path of [...pages, "/style.css", "/ui/apps"]) {
			expect((await request(path)).status, path).toBe(401);
		}
		for (const path of pages) {
			const response = await request(path, { authorization: UI_AUTH });
			expect(response.status, path).toBe(200);
			expect(await response.text(), path).not.toContain(KEY);
		}
	});

	it("submits, lists, and deletes only in the Basic Auth user's namespace", async () => {
		const submitted = await request("/ui/apps", {
			method: "POST",
			authorization: UI_AUTH,
			body: { prompt: PROMPT, user: "another-user" },
		});
		expect(submitted.status).toBe(202);
		expect((await submitted.json()).statusUrl).toMatch(/^\/ui\/apps\//);
		expect(mocks.startTask).toHaveBeenCalledWith("wfs-1/prompt-to-app", [
			expect.objectContaining({ user: "demo" }),
		]);

		mocks.listRunsByUser.mockResolvedValue([storedRun()]);
		const listed = await request("/ui/apps", { authorization: UI_AUTH });
		expect((await listed.json()).runs).toHaveLength(1);
		expect(mocks.listRunsByUser.mock.calls).toEqual([["demo"]]);

		mocks.getRun.mockResolvedValue(storedRun({ user: "acme" }));
		const deleted = await request(`/ui/apps/${RUN_ID}`, {
			method: "DELETE",
			authorization: UI_AUTH,
		});
		expect(deleted.status).toBe(404);
		expect(mocks.claimDelete).not.toHaveBeenCalled();
		expect(mocks.deleteRunWithoutApp).not.toHaveBeenCalled();
	});

	it("lists every stage of RUN_STAGES in order in the stage list and the stage table", async () => {
		const index = await (await request("/", { authorization: UI_AUTH })).text();
		const items = [
			...index.matchAll(/<li data-stage="([a-z_]+)">([\s\S]*?)<\/li>/g),
		];
		expect(items.map(([, stage]) => stage)).toEqual(RUN_STAGES);
		for (const [, stage, item] of items) {
			expect(item, stage).toContain('role="tooltip"');
		}

		const table = await (
			await request("/table", { authorization: UI_AUTH })
		).text();
		const rows = [
			...table.matchAll(/<tr data-stage="([a-z_]+)">([\s\S]*?)<\/tr>/g),
		];
		expect(rows.map(([, stage]) => stage)).toEqual(RUN_STAGES);
		for (const [, stage, row] of rows) {
			expect(row, stage).toContain('class="stage-time"');
			expect(row, stage).toContain('class="stage-links"');
		}
	});
});

describe("GET /v1/apps/:runId", () => {
	it("redacts secrets in the summary and the progress", async () => {
		mocks.getRun.mockResolvedValue(
			storedRun({
				progress: "The deploy lookup failed: postgres://user:pw@host/db",
				summary: "Wired DATABASE_URL postgres://user:pw@host/db for the API.",
			}),
		);

		const response = await request(`/v1/apps/${RUN_ID}`, {
			authorization: BEARER,
		});
		const body = await response.json();

		expect(response.status).toBe(200);
		for (const text of [body.summary, body.progress]) {
			expect(text).not.toContain("postgres://");
			expect(text).toContain("[REDACTED]");
		}
	});

	// A timeout or a cancel stops the task before its catch block writes the failure.
	it("marks a running run failed on read when its task run failed or was canceled", async () => {
		const running = storedRun({ status: "running", finishedAt: null });
		mocks.getRun.mockResolvedValue(running);
		mocks.listRunsByUser.mockResolvedValue([running]);

		mocks.getTaskRun.mockResolvedValue({ status: "running" });
		await request(`/v1/apps/${RUN_ID}`, { authorization: BEARER });
		expect(mocks.finishRun).not.toHaveBeenCalled();

		mocks.getTaskRun.mockResolvedValue({ status: "failed", error: "timed out" });
		await request(`/v1/apps/${RUN_ID}`, { authorization: BEARER });
		expect(mocks.finishRun).toHaveBeenLastCalledWith(RUN_ID, "failed", {
			summary: expect.stringContaining("timed out"),
		});

		// The UI polls only the list, so the list reconciles too.
		mocks.getTaskRun.mockResolvedValue({ status: "canceled" });
		await request("/ui/apps", { authorization: UI_AUTH });
		expect(mocks.finishRun).toHaveBeenLastCalledWith(RUN_ID, "failed", {
			summary: expect.stringContaining("canceled"),
		});
	});
});

describe("DELETE /v1/apps/:runId", () => {
	const remove = () =>
		request(`/v1/apps/${RUN_ID}`, { method: "DELETE", authorization: BEARER });

	it("claims every run of the app and dispatches delete-app", async () => {
		mocks.claimDelete.mockResolvedValue({
			claimed: true,
			runIds: [RUN_ID, "run-older"],
		});

		const response = await remove();

		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({
			status: "deleting",
			runIds: [RUN_ID, "run-older"],
		});
		expect(mocks.claimDelete).toHaveBeenCalledWith("demo", "furniture-catalog");
		expect(mocks.startTask).toHaveBeenCalledWith("wfs-1/delete-app", [
			{ user: "demo", appName: "furniture-catalog" },
		]);
	});

	// The running run would publish the app again after the delete.
	it("refuses with 409 while a run of the app is running", async () => {
		mocks.claimDelete.mockResolvedValue({ claimed: false, reason: "running" });

		expect((await remove()).status).toBe(409);
		expect(mocks.startTask).not.toHaveBeenCalled();
	});

	it("deletes a run that chose no app directly, without a task", async () => {
		mocks.getRun.mockResolvedValue(
			storedRun({ status: "failed", appName: null, blueprintPath: null }),
		);

		const response = await remove();

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ status: "deleted" });
		expect(mocks.deleteRunWithoutApp).toHaveBeenCalledWith(RUN_ID);
		expect(mocks.startTask).not.toHaveBeenCalled();
	});
});
