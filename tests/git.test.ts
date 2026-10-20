import { execSync } from "node:child_process";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Service } from "../app/contracts.js";
import {
	appGitignore,
	cloneAppsRepo,
	commitPaths,
	pushVerified,
	REPO_DIR,
	removeIgnored,
} from "../app/git.js";
import { type ExecResult, type Sandbox, shellEscape } from "../app/sandbox.js";

/** What each commit of the shop app may change. */
const PATHS = ["apps/demo/shop", "render.yaml"];
const PAGE = "<!doctype html><title>Shop</title>";

const staticSite: Service = {
	name: "web",
	kind: "static_site",
	rootDir: "web",
	runtime: "static",
	buildCommand: "npm ci && npm run build",
	staticPublishPath: "dist",
};

const webService: Service = {
	name: "api",
	kind: "web_service",
	rootDir: "api",
	runtime: "node",
	buildCommand: "npm ci && npm run build",
	startCommand: "npm start",
	staticPublishPath: "dist",
};

/** The patterns, without the header. */
const rules = (...services: Service[]) =>
	appGitignore({ services })
		.split("\n")
		.filter((line) => line !== "" && !line.startsWith("#"));

describe("appGitignore", () => {
	it("ignores node_modules and each static site's publish directory, but never the service directory itself", () => {
		expect(rules(staticSite, webService)).toEqual([
			"node_modules/",
			"/web/dist/",
		]);
		// A site without a build publishes its own source.
		expect(
			rules({ ...staticSite, rootDir: ".", staticPublishPath: "." }),
		).toEqual(["node_modules/"]);
		expect(rules({ ...staticSite, staticPublishPath: "./" })).toEqual([
			"node_modules/",
		]);
	});
});

/**
 * Git decides what a pattern matches and what a commit holds, so these tests
 * run real git and a real shell in temporary directories. Nothing here uses
 * the network.
 */
describe("under real git", () => {
	const temporary: string[] = [];

	afterEach(() => {
		for (const dir of temporary.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function tempDir(): string {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "git-test-")));
		temporary.push(dir);
		return dir;
	}

	/**
	 * Runs commands on this machine, isolated from its git config. A git hook
	 * that runs the tests sets GIT_DIR, which would send these commands to the
	 * outer repository.
	 */
	function shell(home: string) {
		const env = {
			...Object.fromEntries(
				Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
			),
			HOME: home,
			XDG_CONFIG_HOME: home,
			GIT_CONFIG_NOSYSTEM: "1",
		};
		return (command: string, cwd = home) =>
			execSync(command, { cwd, env, encoding: "utf8", stdio: "pipe" });
	}

	/** A sandbox that runs each command on this machine, with the clone at `root`. */
	function localSandbox(
		root: string,
		run: (command: string) => string,
	): Sandbox {
		const exec = async (command: string): Promise<ExecResult> => {
			try {
				return { output: run(command.replaceAll(REPO_DIR, root)), exitCode: 0 };
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
		return {
			run: exec,
			async mustRun(command: string, label: string): Promise<string> {
				const result = await exec(command);
				if (result.exitCode !== 0) {
					throw new Error(`${label} failed: ${result.output}`);
				}
				return result.output;
			},
			upload: async (path: string, data: string | Buffer) =>
				writeFileSync(path, data),
		} as unknown as Sandbox;
	}

	function write(dir: string, files: Record<string, string>): void {
		for (const [path, contents] of Object.entries(files)) {
			mkdirSync(dirname(join(dir, path)), { recursive: true });
			writeFileSync(join(dir, path), contents);
		}
	}

	const lines = (output: string) => output.split("\n").filter(Boolean).sort();

	/** A clone whose last commit holds two apps, the root Blueprint, and a README. */
	function clone() {
		const root = tempDir();
		const run = shell(root);
		run("git init -q -b main");
		run("git config user.name test && git config user.email test@example.com");
		write(root, {
			"apps/demo/shop/index.html": PAGE,
			"apps/victim/site/index.html": PAGE,
			"render.yaml": "apps: []\n",
			"README.md": "# Apps\n",
		});
		run("git add -A && git commit -q -m base");
		return { root, run, sandbox: localSandbox(root, run) };
	}

	/** A bare remote that holds the base commit of the clone on main. */
	function remoteOf(repo: ReturnType<typeof clone>) {
		const remote = tempDir();
		repo.run(`git init -q --bare -b main ${shellEscape(remote)}`);
		repo.run(`git push -q ${shellEscape(remote)} HEAD:refs/heads/main`);
		const onRemote = (command: string) =>
			repo.run(`git --git-dir=${shellEscape(remote)} ${command}`);
		return { remote, onRemote };
	}

	const committed = (run: (command: string) => string) =>
		lines(run("git show --name-only --format= HEAD"));

	it("commits only the app directory and the root Blueprint", async () => {
		const { root, run, sandbox } = clone();
		write(root, {
			"apps/demo/shop/index.html": "<p>new</p>",
			"apps/demo/shop/api/index.ts": "export {};",
			"render.yaml": "apps: [shop]\n",
			"apps/victim/site/index.html": "defaced",
			"README.md": "# Changed\n",
		});

		await expect(commitPaths(sandbox, "demo/shop", PATHS)).resolves.toMatch(
			/^[0-9a-f]{40}$/,
		);

		expect(committed(run)).toEqual([
			"apps/demo/shop/api/index.ts",
			"apps/demo/shop/index.html",
			"render.yaml",
		]);
	});

	it("makes no commit when nothing in the app or the root Blueprint changed", async () => {
		const { root, run, sandbox } = clone();
		write(root, { "apps/victim/site/index.html": "defaced" });
		const base = run("git rev-parse HEAD");

		await expect(commitPaths(sandbox, "demo/shop", PATHS)).resolves.toBeNull();
		expect(run("git rev-parse HEAD")).toBe(base);
	});

	it("refuses to push a commit that changes a path outside the allowed paths", async () => {
		const repo = clone();
		const { remote, onRemote } = remoteOf(repo);
		const base = onRemote("rev-parse main");
		write(repo.root, {
			"apps/demo/shop/index.html": "<p>new</p>",
			"apps/demo/shopx/index.html": "planted",
		});
		repo.run("git add -A && git commit -q -m sneaky");

		await expect(
			pushVerified(repo.sandbox, "token", remote, "main", PATHS, async () =>
				commitPaths(repo.sandbox, "demo/shop", PATHS),
			),
		).rejects.toThrow(/outside .* so it was not pushed: apps\/demo\/shopx/);
		expect(onRemote("rev-parse main")).toBe(base);
	});

	// The root Blueprint lists every app, so a concurrent run always changes it.
	it("takes the new tip, makes the change again, and pushes when another run pushed first", async () => {
		const repo = clone();
		const { remote, onRemote } = remoteOf(repo);

		const other = tempDir();
		repo.run(
			`git clone -q -b main ${shellEscape(remote)} ${shellEscape(other)}`,
		);
		write(other, {
			"apps/demo/cafe/index.html": "cafe",
			"render.yaml": "apps: [cafe]\n",
		});
		repo.run(
			"git add -A && git -c user.name=t -c user.email=t@example.com commit -qm cafe && git push -q origin HEAD:main",
			other,
		);

		// As writeRootBlueprint() does, the Blueprint lists the apps of the clone.
		const commit = async () => {
			write(repo.root, { "apps/demo/shop/index.html": "<p>new</p>" });
			const apps = readdirSync(join(repo.root, "apps/demo")).sort();
			write(repo.root, { "render.yaml": `apps: [${apps.join(", ")}]\n` });
			return commitPaths(repo.sandbox, "demo/shop", PATHS);
		};
		await commit();
		const pushed = await pushVerified(
			repo.sandbox,
			"token",
			remote,
			"main",
			PATHS,
			commit,
		);

		expect(onRemote("rev-parse main").trim()).toBe(pushed);
		expect(onRemote("show main:render.yaml")).toBe("apps: [cafe, shop]\n");
		expect(onRemote("show main:apps/demo/cafe/index.html")).toBe("cafe");
	});

	it("refuses a push when the remote branch does not hold the pushed commit", async () => {
		const repo = clone();
		const { remote, onRemote } = remoteOf(repo);
		const base = onRemote("rev-parse main").trim();
		// The remote moves the branch away from what it received.
		const hook = join(remote, "hooks/post-receive");
		writeFileSync(hook, `#!/bin/sh\ngit update-ref refs/heads/main ${base}\n`);
		chmodSync(hook, 0o755);
		write(repo.root, { "apps/demo/shop/index.html": "<p>new</p>" });
		await commitPaths(repo.sandbox, "demo/shop", PATHS);

		await expect(
			pushVerified(repo.sandbox, "token", remote, "main", PATHS, async () =>
				commitPaths(repo.sandbox, "demo/shop", PATHS),
			),
		).rejects.toThrow(/does not match/);
	});

	it("removes ignored files and keeps untracked files that are not ignored", async () => {
		const { root, sandbox } = clone();
		const app = join(root, "apps/demo/shop");
		write(app, {
			".gitignore": appGitignore({ services: [staticSite, webService] }),
			"web/src/main.tsx": "source",
			// Source with the same name as the output of the build.
			"web/src/dist/format.ts": "source",
			"web/dist/index.html": PAGE,
			"api/node_modules/pg/index.js": "js",
		});

		await removeIgnored(sandbox, app);

		const kept = readdirSync(app, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => relative(app, join(entry.parentPath, entry.name)))
			.sort();
		expect(kept).toEqual([
			".gitignore",
			"index.html",
			"web/src/dist/format.ts",
			"web/src/main.tsx",
		]);
	});

	// A link that an earlier commit put in the repository could send a write
	// of the factory out of the clone.
	it("clones with symbolic links as plain files and keeps the token out of .git/config", async () => {
		const source = clone();
		symlinkSync("/usr/bin", join(source.root, "apps/demo/shop/bin"));
		source.run("git add -A && git commit -q -m link");
		const { remote } = remoteOf(source);

		const home = tempDir();
		const run = shell(home);
		run(
			`git config --global url.${shellEscape(`file://${remote}`)}.insteadOf https://github.com/o/r.git`,
		);
		const target = join(home, "clone");

		await cloneAppsRepo(
			localSandbox(target, run),
			"ghs_secret_token",
			{ owner: "o", repo: "r" },
			"main",
		);

		const link = join(target, "apps/demo/shop/bin");
		expect(lstatSync(link).isSymbolicLink()).toBe(false);
		expect(readFileSync(link, "utf8")).toBe("/usr/bin");
		expect(readFileSync(join(target, ".git/config"), "utf8")).not.toContain(
			"ghs_secret_token",
		);
	});
});
