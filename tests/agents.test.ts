/**
 * The executable access review. Tool access is the security boundary between
 * an agent and the machine: these keep the sandbox tools with the builder, and
 * every agent away from Render writes and Render logs.
 */
import { describe, expect, it } from "vitest";
import * as agents from "../app/agents.js";
import type { Agent } from "../app/claude.js";
import { RENDER_READ_ONLY_TOOLS } from "../app/policy.js";

const all: Agent[] = [agents.architect, agents.builder];

const toolNames = (agent: Agent) => (agent.tools ?? []).map((tool) => tool.name);

describe("agent definitions", () => {
	it("gives sandbox tools only to the builder", () => {
		expect(toolNames(agents.builder)).toEqual(
			expect.arrayContaining([
				"sandbox__exec",
				"sandbox__read_file",
				"sandbox__write_file",
			]),
		);
		expect(toolNames(agents.architect)).toEqual([]);
	});

	it("gives the architect only read-only Render tools, and no agent a log tool", () => {
		expect(agents.architect.renderTools?.length).toBeGreaterThan(0);
		expect(agents.builder.renderTools ?? []).toEqual([]);
		for (const agent of all) {
			const granted = agent.renderTools ?? [];
			expect(RENDER_READ_ONLY_TOOLS, agent.id).toEqual(
				expect.arrayContaining([...granted]),
			);
			expect(
				granted.filter((name) => /log/i.test(name)),
				agent.id,
			).toEqual([]);
		}
		expect(RENDER_READ_ONLY_TOOLS.filter((name) => /log/i.test(name))).toEqual(
			[],
		);
	});

	// The id is also the registered task name.
	it("gives every agent a unique id", () => {
		expect(new Set(all.map((agent) => agent.id)).size).toBe(all.length);
	});

	it("gives every agent task an explicit deadline", () => {
		for (const agent of all) {
			expect(agent.timeoutSeconds, agent.id).toBeGreaterThan(0);
			expect(agent.timeoutSeconds, agent.id).toBeLessThanOrEqual(60 * 60);
		}
	});
});
