/**
 * The files of an app, copied between sandboxes as data. readAppFiles() packs
 * them in the sandbox of the build, and writeAppFiles() writes them into a
 * clone in a sandbox that no agent uses.
 *
 * The builder can run any command in the sandbox of its build, so nothing
 * read out of it is trusted: appFiles() accepts only regular files with plain
 * paths below the app directory, up to MAX_APP_BYTES.
 */
import { randomUUID } from "node:crypto";
import { Parser } from "tar";
import { type Sandbox, shellEscape } from "./sandbox.js";

/**
 * The limit of the files of one app. Each service of each app builds from a
 * clone of the apps repository, so a large app makes every deploy slower. The
 * workflow downloads at most four photographs of 2 MB, and the builder can
 * copy them one time. publish-app holds the files in memory, on the starter
 * plan.
 */
export const MAX_APP_BYTES = 50 * 1024 * 1024;

/** The tar types of a regular file. */
const REGULAR_FILE = new Set(["File", "OldFile", "ContiguousFile"]);
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** Ends each heredoc. Base64 has no "_", so no line of a file can end one. */
const FILE_EOF = "FACTORY_FILE_EOF";

/** A file of an app, as the factory copies it out of the sandbox of its build. */
export interface AppFile {
	/** Relative to the app directory. */
	path: string;
	data: Buffer;
	executable: boolean;
}

/**
 * The files of an app, or why the factory does not copy them. The error is
 * for the builder: verify-app gives it to the builder to fix.
 */
export type AppFiles = { files: AppFile[] } | { error: string };

/**
 * Read the files that a commit of the app holds out of the sandbox of its
 * build. The builder can run any command in that sandbox, so this is data
 * that nothing trusts: appFiles() accepts only regular files with plain paths
 * below the app directory.
 */
export async function readAppFiles(
	sandbox: Sandbox,
	appDir: string,
): Promise<AppFiles> {
	const base = `/tmp/vibe-app-${randomUUID()}`;
	const list = shellEscape(`${base}.list`);
	const archive = shellEscape(`${base}.tar`);
	try {
		const packed = await sandbox.run(
			`cd ${shellEscape(appDir)} && ` +
				// An index that does not exist, so that git lists each file that
				// a first commit holds, also a file that the builder staged.
				`GIT_INDEX_FILE=${shellEscape(`${base}.index`)} git ls-files -z --others --exclude-standard >${list} && ` +
				`tar --null --no-recursion -T ${list} -cf ${archive} && ` +
				`wc -c <${archive}`,
		);
		// For example, a process of the builder changed a file during the pack.
		if (packed.exitCode !== 0) {
			return {
				error: `The files of the app could not be packed: ${packed.output.slice(0, 1_000)}`,
			};
		}
		// Stop an archive that is too large before the download.
		const size = Number(packed.output.trim().split("\n").at(-1));
		if (size > MAX_APP_BYTES) return { error: tooLarge(size) };
		return await appFiles(await sandbox.download(`${base}.tar`));
	} finally {
		await sandbox.run(`rm -f ${list} ${archive}`).catch(() => {});
	}
}

/** The files in a tar archive of an app, or why the factory does not copy them. */
export async function appFiles(archive: Buffer): Promise<AppFiles> {
	if (archive.byteLength > MAX_APP_BYTES) {
		return { error: tooLarge(archive.byteLength) };
	}
	// readAppFiles() packs a plain tar. A compressed archive can expand in
	// memory to much more than the limit.
	if (
		archive.subarray(0, GZIP_MAGIC.length).equals(GZIP_MAGIC) ||
		archive.subarray(0, ZSTD_MAGIC.length).equals(ZSTD_MAGIC)
	) {
		return { error: "The archive of the app is compressed." };
	}

	let entries: TarEntry[];
	try {
		entries = await tarEntries(archive);
	} catch (error) {
		return {
			error: `The archive of the app is not a valid tar archive: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	const files: AppFile[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		const error = entryError(entry, seen);
		if (error) return { error };
		seen.add(entry.path);
		// Git keeps only the executable bit of the owner.
		files.push({
			path: entry.path,
			data: entry.data,
			executable: (entry.mode & 0o100) !== 0,
		});
	}
	if (files.length === 0) {
		return { error: "No file in the app directory goes into a commit." };
	}
	return { files };
}

interface TarEntry {
	path: string;
	type: string;
	mode: number;
	data: Buffer;
}

function tarEntries(archive: Buffer): Promise<TarEntry[]> {
	return new Promise((resolve, reject) => {
		const entries: TarEntry[] = [];
		const parser = new Parser({
			// A damaged entry is an error, not a warning that skips the entry.
			strict: true,
			onReadEntry: (entry) => {
				const chunks: Buffer[] = [];
				entry.on("data", (chunk: Buffer) => chunks.push(chunk));
				entry.on("end", () =>
					entries.push({
						path: entry.path,
						type: entry.type,
						mode: entry.mode ?? 0,
						data: Buffer.concat(chunks),
					}),
				);
			},
		});
		parser.on("error", reject);
		parser.on("end", () => resolve(entries));
		parser.end(archive);
	});
}

/** Why the factory does not copy an entry of the archive, or null. */
function entryError(
	entry: TarEntry,
	seen: ReadonlySet<string>,
): string | null {
	if (/\p{Cc}/u.test(entry.path)) {
		return `${JSON.stringify(entry.path)} has a control character in its name.`;
	}
	const path = entry.path.replace(/\/+$/, "");
	// git ls-files gives a Git repository in the app as one directory.
	if (entry.type === "Directory") {
		return `${path} is a Git repository in the app directory. Remove ${path}/.git, so that a commit holds its files.`;
	}
	if (entry.type === "SymbolicLink") {
		return `${path} is a symbolic link. Only regular files are published: replace the link with a copy of the file or directory that it points to.`;
	}
	if (!REGULAR_FILE.has(entry.type)) {
		return `${path} is a ${entry.type} entry. Only regular files are published.`;
	}
	const segments = entry.path.split("/");
	if (
		entry.path.startsWith("/") ||
		segments.some((segment) => ["", ".", ".."].includes(segment))
	) {
		return `${entry.path} is not a plain path below the app directory.`;
	}
	if (segments.some((segment) => segment.toLowerCase() === ".git")) {
		return `${entry.path} is in a .git directory. No file from a .git directory is published.`;
	}
	if (seen.has(entry.path)) {
		return `${entry.path} is in the archive two times.`;
	}
	return null;
}

function tooLarge(bytes: number): string {
	const mb = (value: number) => Math.ceil(value / (1024 * 1024));
	return (
		`The files of the app are ${mb(bytes)} MB, and the limit is ${mb(MAX_APP_BYTES)} MB. ` +
		"Remove large files, and files that are in the app two times."
	);
}

/**
 * Replace the app directory of a clone with the files of the build. One
 * script writes them all, as materializeTemplate() writes a template, and
 * base64 carries each file, so that binary data comes through unchanged.
 */
export async function writeAppFiles(
	sandbox: Sandbox,
	appDir: string,
	files: readonly AppFile[],
): Promise<void> {
	const scriptPath = `/tmp/vibe-app-${randomUUID()}.sh`;
	await sandbox.upload(scriptPath, appFilesScript(files, appDir));
	try {
		await sandbox.mustRun(
			`sh ${shellEscape(scriptPath)}`,
			"Write the files of the app",
		);
	} finally {
		await sandbox.run(`rm -f ${shellEscape(scriptPath)}`).catch(() => {});
	}
}

/**
 * The script that writeAppFiles() runs. Each path is a plain relative path
 * from appFiles(), and the directory is new. So each file goes below the app
 * directory: no symbolic link is there to follow.
 */
function appFilesScript(files: readonly AppFile[], appDir: string): string {
	// "./" first, so that no command reads a path such as "-rf" as an option.
	const local = (path: string) => shellEscape(`./${path}`);
	const directories = new Set<string>();
	for (const { path } of files) {
		const slash = path.lastIndexOf("/");
		if (slash > 0) directories.add(path.slice(0, slash));
	}

	const lines = [
		"set -e",
		`rm -rf ${shellEscape(appDir)}`,
		`mkdir -p ${shellEscape(appDir)}`,
		`cd ${shellEscape(appDir)}`,
	];
	if (directories.size > 0) {
		lines.push(`mkdir -p ${[...directories].sort().map(local).join(" ")}`);
	}
	for (const file of files) {
		// One string for each file, with a line break after each 76 characters.
		// An array of short lines takes much more memory.
		const base64 = file.data
			.toString("base64")
			.replace(/.{76}(?=.)/g, "$&\n");
		lines.push(
			`base64 -d >${local(file.path)} <<'${FILE_EOF}'`,
			base64,
			FILE_EOF,
		);
		if (file.executable) lines.push(`chmod 755 ${local(file.path)}`);
	}
	return `${lines.join("\n")}\n`;
}
