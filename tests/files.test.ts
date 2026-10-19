import { gzipSync } from "node:zlib";
import { Header, type HeaderData } from "tar";
import { describe, expect, it, vi } from "vitest";
import { appFiles, MAX_APP_BYTES, readAppFiles } from "../app/files.js";
import type { ExecResult, Sandbox } from "../app/sandbox.js";

const OK: ExecResult = { output: "", exitCode: 0 };

describe("readAppFiles", () => {
	/** A sandbox that answers the pack command, and then each rm. */
	function packing(result: ExecResult) {
		const download = vi.fn();
		const run = vi.fn(async () => OK).mockResolvedValueOnce(result);
		return { sandbox: { run, download } as unknown as Sandbox, download };
	}

	it("stops an archive over the limit before the download", async () => {
		const { sandbox, download } = packing({
			output: `${MAX_APP_BYTES + 1}\n`,
			exitCode: 0,
		});

		await expect(
			readAppFiles(sandbox, "/home/user/repo/apps/demo/shop"),
		).resolves.toEqual({
			error: expect.stringContaining("the limit is 50 MB"),
		});
		expect(download).not.toHaveBeenCalled();
	});

	// A problem of the files is for the builder to fix, so it is a result.
	it("gives the output of a pack that fails", async () => {
		const { sandbox, download } = packing({
			output: "tar: web/server.log: file changed as we read it\n",
			exitCode: 1,
		});

		await expect(
			readAppFiles(sandbox, "/home/user/repo/apps/demo/shop"),
		).resolves.toEqual({
			error:
				"The files of the app could not be packed: tar: web/server.log: file changed as we read it\n",
		});
		expect(download).not.toHaveBeenCalled();
	});
});

/**
 * A tar archive with entries that tar does not make from the app directory.
 * The builder controls its sandbox, so it can put any archive there.
 */
function tarOf(
	entries: {
		path: string;
		type?: HeaderData["type"];
		data?: string;
		mode?: number;
		linkpath?: string;
	}[],
): Buffer {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		const data = Buffer.from(entry.data ?? "");
		const header = Buffer.alloc(512);
		new Header({
			path: entry.path,
			type: entry.type ?? "File",
			mode: entry.mode ?? 0o644,
			size: data.length,
			mtime: new Date(0),
			linkpath: entry.linkpath,
		}).encode(header, 0);
		blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
	}
	return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

describe("appFiles", () => {
	it("reads the regular files of an archive, with the executable bit", async () => {
		await expect(
			appFiles(
				tarOf([
					{ path: "index.html", data: "<p>Shop</p>" },
					{ path: "bin/build.sh", data: "#!/bin/sh\n", mode: 0o755 },
				]),
			),
		).resolves.toEqual({
			files: [
				{ path: "index.html", data: Buffer.from("<p>Shop</p>"), executable: false },
				{ path: "bin/build.sh", data: Buffer.from("#!/bin/sh\n"), executable: true },
			],
		});
	});

	// Each of these would write outside the app directory, or into git.
	it.each([
		["/etc/cron.d/job", "is not a plain path below the app directory"],
		["../victim/site/index.html", "is not a plain path below the app directory"],
		["web/../../victim/site/index.html", "is not a plain path below the app directory"],
		["./index.html", "is not a plain path below the app directory"],
		["web//index.html", "is not a plain path below the app directory"],
		[".git/config", "is in a .git directory"],
		["web/.GIT/hooks/post-checkout", "is in a .git directory"],
		["index\n.html", "has a control character in its name"],
	])("refuses the path %j", async (path, reason) => {
		await expect(appFiles(tarOf([{ path, data: "x" }]))).resolves.toEqual({
			error: expect.stringContaining(reason),
		});
	});

	it.each<[HeaderData["type"], string | undefined, string]>([
		["SymbolicLink", "/usr/local/bin/git", "home.html is a symbolic link."],
		["Link", "index.html", "home.html is a Link entry."],
		["FIFO", undefined, "home.html is a FIFO entry."],
		["CharacterDevice", undefined, "home.html is a CharacterDevice entry."],
		["Directory", undefined, "home.html is a Git repository"],
	])("refuses a %s entry", async (type, linkpath, reason) => {
		await expect(
			appFiles(tarOf([{ path: "home.html", type, linkpath }])),
		).resolves.toEqual({ error: expect.stringContaining(reason) });
	});

	it("refuses a path that is in the archive two times", async () => {
		await expect(
			appFiles(
				tarOf([
					{ path: "index.html", data: "first" },
					{ path: "index.html", data: "second" },
				]),
			),
		).resolves.toEqual({
			error: "index.html is in the archive two times.",
		});
	});

	// readAppFiles() packs a plain tar. Compressed data can expand in memory
	// to much more than the limit.
	it("refuses a compressed archive", async () => {
		await expect(
			appFiles(gzipSync(tarOf([{ path: "index.html", data: "x" }]))),
		).resolves.toEqual({ error: "The archive of the app is compressed." });
	});

	it("refuses data that is not a tar archive", async () => {
		await expect(appFiles(Buffer.from("not an archive"))).resolves.toEqual({
			error: expect.stringContaining("is not a valid tar archive"),
		});
	});

	it("refuses an archive over the limit", async () => {
		await expect(appFiles(Buffer.alloc(MAX_APP_BYTES + 1))).resolves.toEqual({
			error: expect.stringContaining("the limit is 50 MB"),
		});
	});
});
