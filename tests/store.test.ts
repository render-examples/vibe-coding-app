/**
 * Postgres can close a connection of the pool, for example in a restart. For
 * an idle connection, the pool emits "error". For a connection that a
 * transaction holds, the client emits "error". An "error" event with no
 * listener stops the gateway and the workflows host. No test connects to
 * Postgres: the pool opens a connection only for a query, and the transaction
 * gets a fake client.
 */
import { EventEmitter } from "node:events";
import type { PoolClient } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { factoryConfig } from "../factory.config.js";
import { claimDelete, claimRun, db } from "../app/store.js";

describe("db", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("logs the error of an idle connection and does not throw it", () => {
		vi.stubEnv("DATABASE_URL", "postgres://factory@127.0.0.1:5432/factory");
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const error = new Error(
			"terminating connection due to administrator command",
		);

		expect(() => db().emit("error", error)).not.toThrow();
		expect(logged).toHaveBeenCalledWith(
			"Lost an idle Postgres connection:",
			error,
		);
	});
});

describe("the transaction of an app lock", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("logs the error of a closed connection and gives the caller the error of the query", async () => {
		vi.stubEnv("DATABASE_URL", "postgres://factory@127.0.0.1:5432/factory");
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const terminated = new Error(
			"terminating connection due to administrator command",
		);
		const closed = new Error("Connection terminated unexpectedly");
		// As in pg after pg_terminate_backend(): the lock query fails, and the
		// rollback waits. Then the socket closes, and the client emits "error".
		let failRollback: (error: Error) => void = () => {};
		const rollback = new Promise((_, reject) => {
			failRollback = reject;
		});
		const client = Object.assign(new EventEmitter(), {
			release: vi.fn(),
			query: vi.fn(async (text: string) => {
				if (text === "begin") return { rows: [] };
				if (text === "rollback") return rollback;
				throw terminated;
			}),
		});
		vi.spyOn(db(), "connect").mockImplementation(
			async () => client as unknown as PoolClient,
		);

		const claim = claimDelete("demo", "furniture-catalog");
		await vi.waitFor(() =>
			expect(client.query).toHaveBeenLastCalledWith("rollback"),
		);
		expect(() => client.emit("error", closed)).not.toThrow();
		failRollback(closed);

		await expect(claim).rejects.toBe(terminated);
		expect(logged).toHaveBeenCalledWith(
			"Lost a Postgres connection in a transaction:",
			closed,
		);
		// The pool gives this client to the next transaction, so no listener
		// can remain.
		expect(client.listenerCount("error")).toBe(0);
		expect(client.release).toHaveBeenCalledOnce();
	});
});

/**
 * Under READ COMMITTED, two claims at one time each count the running rows
 * without the row of the other, and both can pass the cap. Each claim holds
 * one advisory lock, so the next claim counts after the commit.
 */
describe("claimRun", () => {
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

	const statements = (client: { query: { mock: { calls: unknown[][] } } }) =>
		client.query.mock.calls.map(([text]) =>
			String(text).trim().split(/\s+/).slice(0, 2).join(" "),
		);

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("inserts the run while it holds the claim lock", async () => {
		vi.stubEnv("DATABASE_URL", "postgres://factory@127.0.0.1:5432/factory");
		const client = fakeClient((text) => ({
			rows: [],
			rowCount: text.startsWith("insert") ? 1 : 0,
		}));

		await expect(claimRun(RUN)).resolves.toEqual({ claimed: true });

		expect(statements(client)).toEqual([
			"begin",
			"select pg_advisory_xact_lock($1::bigint)",
			"insert into",
			"commit",
		]);
		// The one-key form: the app locks take the two-key form, and Postgres
		// keeps the two apart.
		const [, lockValues] = client.query.mock.calls[1] as unknown[];
		expect(lockValues).toEqual([expect.any(Number)]);
		expect(client.query.mock.calls[2]).toEqual([
			expect.stringContaining("where (select count(*) from runs where status = 'running') < $5"),
			[
				"run-1",
				"key-12345",
				RUN.prompt,
				"demo",
				factoryConfig.maxConcurrentRuns,
			],
		]);
		expect(client.listenerCount("error")).toBe(0);
		expect(client.release).toHaveBeenCalledOnce();
	});

	it("gives the run of a key that it saw before", async () => {
		vi.stubEnv("DATABASE_URL", "postgres://factory@127.0.0.1:5432/factory");
		const client = fakeClient((text) =>
			text.startsWith("select id")
				? { rows: [{ id: "run-0" }], rowCount: 1 }
				: { rows: [], rowCount: 0 },
		);

		await expect(claimRun(RUN)).resolves.toEqual({
			claimed: false,
			reason: "duplicate",
			runId: "run-0",
		});
		expect(statements(client)).toEqual([
			"begin",
			"select pg_advisory_xact_lock($1::bigint)",
			"insert into",
			"select id",
			"commit",
		]);
	});

	it("refuses a run at capacity", async () => {
		vi.stubEnv("DATABASE_URL", "postgres://factory@127.0.0.1:5432/factory");
		fakeClient(() => ({ rows: [], rowCount: 0 }));

		await expect(claimRun(RUN)).resolves.toEqual({
			claimed: false,
			reason: "at_capacity",
		});
	});

	it("rolls back and gives the error when the insert fails", async () => {
		vi.stubEnv("DATABASE_URL", "postgres://factory@127.0.0.1:5432/factory");
		const failure = new Error("canceling statement due to lock timeout");
		const client = fakeClient((text) => {
			if (text.startsWith("insert")) throw failure;
			return { rows: [] };
		});

		await expect(claimRun(RUN)).rejects.toBe(failure);
		expect(statements(client)).toEqual([
			"begin",
			"select pg_advisory_xact_lock($1::bigint)",
			"insert into",
			"rollback",
		]);
		expect(client.listenerCount("error")).toBe(0);
		expect(client.release).toHaveBeenCalledOnce();
	});
});
