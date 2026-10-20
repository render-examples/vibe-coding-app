import { execSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { Header, type HeaderData } from "tar";
import { afterEach, describe, expect, it } from "vitest";
import {
	appFiles,
	MAX_APP_BYTES,
	readAppFiles,
	writeAppFiles,
} from "../app/files.js";
import type { ExecResult, Sandbox } from "../app/sandbox.js";

/**
 * A tar archive with any entries. The builder controls its sandbox, so it can
 * put any archive where readAppFiles() downloads one.
 */
function tarOf(
	entries: { path: string; type?: HeaderData["type"]; linkpath?: string }[],
): Buffer {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		const data = Buffer.from(entry.type ? "" : "x");
		const header = Buffer.alloc(512);
		new Header({
			path: entry.path,
			type: entry.type ?? "File",
			mode: 0o644,
			size: data.length,
			mtime: new Date(0),
			linkpath: entry.linkpath,
		}).encode(header, 0);
		blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
	}
	return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

describe("the files of an app", () => {
	const temporary: string[] = [];

	afterEach(() => {
		for (const dir of temporary.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	/**
	 * A new repository and a sandbox that runs each command in it on this
	 * machine. A git hook that runs the tests sets GIT_DIR, which would send
	 * these commands to the outer repository.
	 */
	function repository() {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "files-test-")));
		temporary.push(root);
		const env = {
			...Object.fromEntries(
				Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
			),
			HOME: root,
			XDG_CONFIG_HOME: root,
			GIT_CONFIG_NOSYSTEM: "1",
			// The tar of macOS adds a ._ file for the metadata of each file.
			COPYFILE_DISABLE: "1",
		};
		const run = async (command: string): Promise<ExecResult> => {
			try {
				return {
					output: execSync(command, {
						cwd: root,
						env,
						encoding: "utf8",
						stdio: "pipe",
					}),
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
			async mustRun(command: string, label: string): Promise<string> {
				const result = await run(command);
				if (result.exitCode !== 0) {
					throw new Error(`${label} failed: ${result.output}`);
				}
				return result.output;
			},
			download: async (path: string) => readFileSync(path),
			upload: async (path: string, data: string | Buffer) =>
				writeFileSync(path, data),
		} as unknown as Sandbox;
		execSync("git init -q", { cwd: root, env });
		return { root, sandbox };
	}

	function write(dir: string, files: Record<string, string | Buffer>): void {
		for (const [path, contents] of Object.entries(files)) {
			mkdirSync(dirname(join(dir, path)), { recursive: true });
			writeFileSync(join(dir, path), contents);
		}
	}

	it("reads the files a commit would hold and writes them into another clone unchanged", async () => {
		// Every byte value, as a photograph can hold them.
		const photo = Buffer.from([...Array(256).keys()]);
		const build = repository();
		const app = join(build.root, "apps/demo/shop");
		write(app, {
			".gitignore": "node_modules/\n",
			"index.html": "<p>Shop</p>",
			"assets/chair.jpg": photo,
			"bin/build.sh": "#!/bin/sh\necho built\n",
			"node_modules/vite/index.js": "js",
		});
		chmodSync(join(app, "bin/build.sh"), 0o755);

		const read = await readAppFiles(build.sandbox, app);
		if ("error" in read) throw new Error(read.error);
		expect(read.files.map(({ path }) => path).sort()).toEqual([
			".gitignore",
			"assets/chair.jpg",
			"bin/build.sh",
			"index.html",
		]);

		const target = repository();
		const copy = join(target.root, "apps/demo/shop");
		write(copy, { "stale.html": "from an earlier run" });
		await writeAppFiles(target.sandbox, copy, read.files);

		expect(readFileSync(join(copy, "assets/chair.jpg"))).toEqual(photo);
		expect(statSync(join(copy, "bin/build.sh")).mode & 0o100).toBe(0o100);
		expect(statSync(join(copy, "index.html")).mode & 0o100).toBe(0);
		expect(() => statSync(join(copy, "stale.html"))).toThrow();
	});

	it("refuses a symbolic link, a nested Git repository, and a path outside the app directory", async () => {
		const refused = async (entry: Parameters<typeof tarOf>[0][number]) => {
			const result = await appFiles(tarOf([{ path: "index.html" }, entry]));
			return "error" in result ? result.error : null;
		};

		expect(
			await refused({
				path: "home.html",
				type: "SymbolicLink",
				linkpath: "/usr/bin/git",
			}),
		).toContain("symbolic link");
		// git ls-files gives a nested repository as one directory.
		expect(await refused({ path: "web/", type: "Directory" })).toContain(
			"Git repository",
		);
		expect(await refused({ path: ".git/hooks/post-checkout" })).toContain(
			".git",
		);
		expect(await refused({ path: "../victim/site/index.html" })).toContain(
			"not a plain path",
		);
		expect(await refused({ path: "/etc/cron.d/job" })).toContain(
			"not a plain path",
		);
	});

	it("refuses an app over the size limit", async () => {
		await expect(appFiles(Buffer.alloc(MAX_APP_BYTES + 1))).resolves.toEqual({
			error: expect.stringContaining("the limit is 50 MB"),
		});
	});

	// A compressed archive can expand in memory to much more than the limit.
	it("refuses a compressed archive", async () => {
		await expect(
			appFiles(gzipSync(tarOf([{ path: "index.html" }]))),
		).resolves.toEqual({ error: expect.stringContaining("compressed") });
	});
});
