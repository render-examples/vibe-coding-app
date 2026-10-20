/**
 * The template is only worth having if it stays true. These pin the three
 * ways it can rot without anything else noticing: files going missing, the
 * extraction script mangling them on the way into the sandbox, and the
 * template drifting away from the manifest the builder is told to return.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { templateLines } from "../app/build.js";
import { extractionScript, readTemplate } from "../app/templates.js";

const files = await readTemplate("fullstack");
const byPath = new Map(files.map((file) => [file.path, file.contents]));

function read(path: string): string {
	const contents = byPath.get(path);
	if (contents === undefined)
		throw new Error(`${path} is missing from the template`);
	return contents;
}

describe("the fullstack template", () => {
	// A local build leaves node_modules and dist behind, and they would ship
	// into every generated app.
	it("reads both tiers from disk, with their lockfiles and without dependencies or build output", () => {
		const paths = files.map((file) => file.path);

		expect(paths).toEqual(
			expect.arrayContaining([
				"web/package-lock.json",
				"web/src/App.tsx",
				"api/package-lock.json",
				"api/src/index.ts",
				"api/sql/schema.sql",
				"api/sql/seed.sql",
			]),
		);
		expect(
			paths.filter((path) =>
				/(^|\/)(node_modules|dist)\/|\.tsbuildinfo$/.test(path),
			),
		).toEqual([]);
	});

	// Quoted heredocs: the template's ${...} in TypeScript and SQL must not be
	// expanded by the shell on the way in.
	it("has an extraction script that recreates every file byte for byte", () => {
		const dir = mkdtempSync(join(tmpdir(), "template-test-"));
		try {
			const app = join(dir, "apps", "demo", "shop");
			execFileSync("mkdir", ["-p", app]);
			execFileSync("sh", ["-c", extractionScript(files, app)]);

			for (const file of files) {
				// A heredoc always ends its last line.
				const expected = file.contents.endsWith("\n")
					? file.contents
					: `${file.contents}\n`;
				expect(readFileSync(join(app, file.path), "utf8"), file.path).toBe(
					expected,
				);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("matches the manifest that the builder is told to return", () => {
		const manifest = templateLines(files.map((file) => file.path));
		const value = (pattern: RegExp) => {
			const match = manifest.match(pattern);
			if (!match) throw new Error(`The manifest has no ${pattern}`);
			return match[1];
		};
		const scripts = (dir: string) =>
			JSON.parse(read(`${dir}/package.json`)).scripts as Record<string, string>;

		// Each rootDir is a tier, and npm ci needs its lockfile.
		const web = value(/web: static_site, rootDir (\S+),/);
		const api = value(/api: web_service, rootDir (\S+),/);
		for (const dir of [web, api]) {
			expect(byPath.has(`${dir}/package-lock.json`), dir).toBe(true);
		}
		expect(manifest).toContain("build `npm ci && npm run build`");
		expect(scripts(web).build).toContain("vite build");
		expect(scripts(api).build).toBeTruthy();

		// Vite writes dist unless the config says otherwise.
		expect(value(/staticPublishPath (\S+),/)).toBe("dist");
		expect(read(`${web}/vite.config.ts`)).not.toContain("outDir");

		expect(
			scripts(api)[value(/preDeployCommand `npm run (\S+)`/)],
		).toBeTruthy();
		expect(manifest).toContain("start `npm start`");
		expect(scripts(api).start).toBeTruthy();

		const server = read(`${api}/src/index.ts`);
		expect(server).toContain(`"${value(/healthCheckPath (\S+),/)}"`);
		expect(server).toContain(`"${value(/dataCheckPath (\S+),/)}"`);

		expect(read(`${web}/src/lib/api.ts`)).toContain(
			value(/envVar (\S+) fromService api/),
		);
		expect(manifest).toContain(
			`Files: ${files.map((file) => file.path).join(", ")}`,
		);
	});
});
