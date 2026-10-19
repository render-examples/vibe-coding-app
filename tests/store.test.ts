/**
 * No test connects to Postgres: the pool opens a connection only for a query,
 * and each transaction gets a fake client.
 */
import { EventEmitter } from "node:events";
import type { PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimRun, db } from "../app/store.js";

const RUN = {
	id: "run-1",
	idempotencyKey: "key-12345",
	prompt: "Sell handmade walnut furniture online",
	user: "demo",
};

/** A client of the pool that answers each query with `answer`. */
function fakeClient(
	answer: (text: string) => { rows: unknown[]; rowCount?: number },
) {
	const client = Object.assign(new EventEmitter(), {
		release: vi.fn(),
		query: vi.fn(async (text: string) => answer(text)),
	});
	vi.spyOn(db(), "connect").mockImplementation(
		async () => client as unknown as PoolClient,
	);
	return client;
}

/** What kind of statement each query was. */
const statements = (client: ReturnType<typeof fakeClient>) =>
	client.query.mock.calls.map(([text]) => {
		if (/pg_advisory_xact_lock/.test(text)) return "lock";
		return text.trim().split(/\s+/)[0];
	});

beforeEach(() => {
	vi.stubEnv("DATABASE_URL", "postgres://factory@127.0.0.1:5432/factory");
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("claimRun", () => {
	// Under READ COMMITTED, two claims at once each count the running rows
	// without the other's row, and both could take the last slot.
	it("inserts the run inside a transaction, under an advisory lock taken before the insert", async () => {
		const client = fakeClient((text) => ({
			rows: [],
			rowCount: text.trim().startsWith("insert") ? 1 : 0,
		}));

		await expect(claimRun(RUN)).resolves.toEqual({ claimed: true });

		expect(statements(client)).toEqual(["begin", "lock", "insert", "commit"]);
		expect(client.release).toHaveBeenCalledOnce();
	});

	it("reports a seen idempotency key as a duplicate of its run, and a full factory as at capacity", async () => {
		fakeClient((text) =>
			text.startsWith("select id")
				? { rows: [{ id: "run-0" }], rowCount: 1 }
				: { rows: [], rowCount: 0 },
		);
		await expect(claimRun(RUN)).resolves.toEqual({
			claimed: false,
			reason: "duplicate",
			runId: "run-0",
		});

		vi.restoreAllMocks();
		fakeClient(() => ({ rows: [], rowCount: 0 }));
		await expect(claimRun(RUN)).resolves.toEqual({
			claimed: false,
			reason: "at_capacity",
		});
	});
});

describe("a lost Postgres connection", () => {
	// An "error" event with no listener stops the gateway and the workflows host.
	it("does not crash the process, idle or in a transaction, and the client is released", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const closed = new Error("Connection terminated unexpectedly");
		const terminated = new Error(
			"terminating connection due to administrator command",
		);

		expect(() => db().emit("error", closed)).not.toThrow();

		// As in pg: the query fails, and the client emits "error" as the socket
		// closes. Without a listener, emit() would throw `closed` instead.
		const client = fakeClient((text) => {
			if (text === "begin" || text === "rollback") return { rows: [] };
			client.emit("error", closed);
			throw terminated;
		});

		await expect(claimRun(RUN)).rejects.toBe(terminated);
		expect(client.release).toHaveBeenCalledOnce();
		// The pool hands this client to the next transaction.
		expect(client.listenerCount("error")).toBe(0);
	});
});
