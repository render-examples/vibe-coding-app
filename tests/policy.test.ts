import { describe, expect, it } from "vitest";
import {
	checkToolCall,
	pinRenderWorkspace,
	redactSecrets,
} from "../app/policy.js";

const APP_DIR = "/home/user/repo/apps/demo/shop";

const tool = (name: string, input: Record<string, unknown>) =>
	checkToolCall(name, input, APP_DIR);

describe("checkToolCall", () => {
	// Logs can hold secrets, and no code can redact what an agent reads.
	it("denies a Render MCP tool that is not on the read-only list, including list_logs", () => {
		expect(checkToolCall("mcp__render__create_web_service", {})).toContain(
			"read-only allowlist",
		);
		expect(checkToolCall("mcp__render__list_logs", {})).toContain(
			"read-only allowlist",
		);
	});

	it("allows a Render MCP tool on the read-only list", () => {
		expect(
			checkToolCall("mcp__render__get_service", { serviceId: "srv-1" }),
		).toBeNull();
	});

	it("denies a sandbox path that escapes the app directory", () => {
		expect(
			tool("sandbox__write_file", { path: "../../victim/site/index.html" }),
		).toContain("outside the app directory");
		expect(tool("sandbox__read_file", { path: "/etc/passwd" })).toContain(
			"outside the app directory",
		);
		// Shares the prefix of the app directory, but is not in it.
		expect(
			tool("sandbox__read_file", {
				path: "/home/user/repo/apps/demo/shopx/x.ts",
			}),
		).toContain("outside the app directory");
		expect(
			tool("sandbox__exec", { command: "ls", cwd: "/home/user/repo" }),
		).toContain("outside the app directory");
	});

	it("allows a sandbox path inside the app directory or /tmp", () => {
		expect(
			tool("sandbox__read_file", { path: "web/../api/index.ts" }),
		).toBeNull();
		expect(
			tool("sandbox__read_file", { path: `${APP_DIR}/index.html` }),
		).toBeNull();
		expect(
			tool("sandbox__write_file", { path: "/tmp/scratch.json" }),
		).toBeNull();
	});

	// A pattern cannot tell a safe command from a harmful one. The sandbox
	// limits what a command can reach.
	it("does not inspect shell commands or file contents", () => {
		expect(
			tool("sandbox__exec", { command: "rm -rf /etc && cat ../../x" }),
		).toBeNull();
		expect(
			tool("sandbox__write_file", {
				path: "src/main.ts",
				content: 'import { api } from "../../../../etc/api";\n',
			}),
		).toBeNull();
	});
});

describe("pinRenderWorkspace", () => {
	// With a key that reaches several workspaces, a call without one fails.
	it("names the factory's workspace in every Render tool call, over the agent's choice", () => {
		expect(
			pinRenderWorkspace("mcp__render__list_services", {}, "tea-factory"),
		).toEqual({ workspaceId: "tea-factory" });
		expect(
			pinRenderWorkspace(
				"mcp__render__get_service",
				{ serviceId: "srv-1", workspaceId: "tea-other" },
				"tea-factory",
			),
		).toEqual({ serviceId: "srv-1", workspaceId: "tea-factory" });
	});

	it("leaves the input of other tools alone", () => {
		expect(
			pinRenderWorkspace("sandbox__exec", { command: "ls" }, "tea-factory"),
		).toBeUndefined();
	});
});

describe("redactSecrets", () => {
	it("removes Anthropic, GitHub, and Render keys and Postgres URLs, and leaves other text", () => {
		const secrets = [
			"sk-ant-api03-abcdefghijklmnop",
			"ghp_abcdefghijklmnopqrst",
			"ghs_abcdefghijklmnopqrst",
			"github_pat_abcdefghijklmnop",
			"rnd_abcdefghijklmnop",
			"postgres://app:hunter2@db.internal:5432/appdb",
			"postgresql://app:hunter2@db.internal/appdb",
		];

		const redacted = redactSecrets(
			`Deploy failed. ${secrets.join(" and ")} were set.`,
		);

		for (const secret of secrets) expect(redacted).not.toContain(secret);
		expect(redacted).toMatch(/^Deploy failed\. \[REDACTED\] and /);
		expect(redacted).toMatch(/ were set\.$/);
		expect(redactSecrets("Added a test for the parser.")).toBe(
			"Added a test for the parser.",
		);
	});
});
