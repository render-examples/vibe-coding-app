import { execSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ExecResult, type Sandbox, shellEscape } from "../app/sandbox.js";
import {
	MAX_OUTPUT_CHARS,
	sandboxApplyPatch,
	sandboxExec,
	sandboxExecTool,
	sandboxWriteFile,
	type ToolContext,
} from "../app/tools.js";

/**
 * A git hook that runs the tests sets GIT_DIR, which would send git apply to
 * the outer repository.
 */
const env = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);

/**
 * A sandbox that runs each command in a real shell on this machine. macOS has
 * no coreutils `timeout`, so the fake unwraps it and can simulate its 124 exit.
 */
function localSandbox(timedOutCommand?: string) {
	const uploaded: string[] = [];
	const commands: string[] = [];
	const run = async (wrapped: string): Promise<ExecResult> => {
		commands.push(wrapped);
		if (
			timedOutCommand &&
			wrapped.includes(`sh -c ${shellEscape(timedOutCommand)}`)
		) {
			return { output: "", exitCode: 124 };
		}
		const command = wrapped.replace(
			/timeout --signal=TERM --kill-after=5s [0-9.]+s sh -c /,
			"sh -c ",
		);
		try {
			return {
				output: execSync(command, { encoding: "utf8", env, stdio: "pipe" }),
				exitCode: 0,
			};
		} catch (error) {
			const failed = error as {
				status?: number;
				stdout?: string;
				stderr?: string;
			};
			return {
				output: `${failed.stdout ?? ""}${failed.stderr ?? ""}`,
				exitCode: failed.status ?? 1,
			};
		}
	};
	const sandbox = {
		run,
		async upload(path: string, data: string) {
			uploaded.push(path);
			writeFileSync(path, data);
		},
		async writeFile(path: string, data: string) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, data);
		},
	} as unknown as Sandbox;
	return { sandbox, uploaded, commands };
}

describe("sandbox tools", () => {
	const temporary: string[] = [];

	afterEach(() => {
		for (const dir of temporary.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	/** An app directory inside a parent that stands for the apps repository. */
	function context(
		timedOutCommand?: string,
	): ToolContext & { uploaded: string[]; commands: string[]; repo: string } {
		// Keep this outside /tmp. The tool deliberately permits /tmp as scratch,
		// so a repository created there cannot test an absolute path escape.
		const repo = realpathSync(
			mkdtempSync(join(dirname(process.cwd()), ".tools-test-")),
		);
		temporary.push(repo);
		const workDir = join(repo, "apps/demo/shop");
		mkdirSync(workDir, { recursive: true });
		const { sandbox, uploaded, commands } = localSandbox(timedOutCommand);
		return { sandbox, workDir, uploaded, commands, repo };
	}

	it("resolves a relative path against the app directory and rejects a path outside it and /tmp", async () => {
		const ctx = context();

		const wrote = await sandboxWriteFile.invoke(
			{ path: "src/x.ts", content: "export {};" },
			ctx,
		);
		expect(wrote.isError).toBeUndefined();
		expect(readFileSync(join(ctx.workDir, "src/x.ts"), "utf8")).toBe(
			"export {};",
		);

		for (const path of [
			"../../victim/site/index.html",
			`${ctx.repo}/render.yaml`,
		]) {
			const refused = await sandboxWriteFile.invoke(
				{ path, content: "planted" },
				ctx,
			);
			expect(refused.isError).toBe(true);
		}
		expect(existsSync(join(ctx.repo, "apps/victim"))).toBe(false);
		expect(existsSync(join(ctx.repo, "render.yaml"))).toBe(false);
	});

	// The exec API starts in `/`. A run once built a whole app from relative
	// paths outside the directory that gets committed.
	it("runs sandbox__exec from the app directory and reports a non-zero exit as an error", async () => {
		const ctx = context();

		const pwd = await sandboxExec.invoke({ command: "pwd" }, ctx);
		expect(pwd).toEqual({ content: `${ctx.workDir}\n`, isError: false });

		const failed = await sandboxExec.invoke(
			{ command: "echo '1 failing'; exit 3" },
			ctx,
		);
		expect(failed.isError).toBe(true);
		expect(failed.content).toContain("Exit code: 3");
		expect(failed.content).toContain("1 failing");
	});

	it("terminates a sandbox__exec command that does not exit", async () => {
		const ctx = context("sleep 10");
		const execWithShortTimeout = sandboxExecTool(0.05);

		const started = Date.now();
		const timedOut = await execWithShortTimeout.invoke(
			{ command: "sleep 10" },
			ctx,
		);

		expect(Date.now() - started).toBeLessThan(2_000);
		expect(ctx.commands[0]).toContain(
			"timeout --signal=TERM --kill-after=5s 0.05s sh -c",
		);
		expect(timedOut).toEqual({
			content: "Command timed out after 0.05 seconds.",
			isError: true,
		});
	});

	it("applies a patch with sandbox__apply_patch and removes the patch file whether it applies or not", async () => {
		const ctx = context();
		writeFileSync(join(ctx.workDir, "index.html"), "old\n");
		const diff =
			"--- a/index.html\n+++ b/index.html\n@@ -1 +1 @@\n-old\n+new\n";

		const applied = await sandboxApplyPatch.invoke({ diff }, ctx);
		expect(applied.isError).toBeUndefined();
		expect(readFileSync(join(ctx.workDir, "index.html"), "utf8")).toBe("new\n");

		const rejected = await sandboxApplyPatch.invoke({ diff }, ctx);
		expect(rejected.isError).toBe(true);
		expect(rejected.content).toContain("Patch failed");

		expect(ctx.uploaded).toHaveLength(2);
		for (const path of ctx.uploaded) expect(existsSync(path)).toBe(false);
	});

	it("truncates output past the limit", async () => {
		const ctx = context();

		const out = await sandboxExec.invoke(
			{ command: `head -c ${MAX_OUTPUT_CHARS + 1000} /dev/zero | tr '\\0' a` },
			ctx,
		);

		expect(out.content.startsWith("a".repeat(MAX_OUTPUT_CHARS))).toBe(true);
		expect(out.content).toContain("truncated, 1000 chars omitted");
	});
});

describe("shellEscape", () => {
	// Model output, branch names, and file paths all reach a shell.
	it("passes any string through a real shell as one argument", () => {
		const value = `it's "$(whoami)" \`id\` $HOME; rm -rf / && echo\nnext line\\`;

		const echoed = execSync(`printf '%s|' ${shellEscape(value)}`, {
			encoding: "utf8",
		});

		expect(echoed).toBe(`${value}|`);
	});
});
