/**
 * Commit an empty root Blueprint to the apps repository, once, before the
 * first run.
 *
 *   npm run setup:apps-repo
 *
 * Render can only create a Blueprint from a file that exists. With this file
 * in place, you connect the apps Blueprint before the first run, and that run
 * deploys all the way instead of stopping at awaiting_blueprint. A repository
 * that already has the file is left alone.
 */
import { factoryConfig } from "../factory.config.js";
import { rootBlueprint } from "../app/blueprint.js";
import { appsRepo } from "../app/config.js";
import { githubToken } from "../app/github.js";
import { bold, dim, exitWith, heading, print } from "./support.js";

const API = process.env.GITHUB_API_URL ?? "https://api.github.com";

const repo = appsRepo();
const token = await githubToken();
const { branch, blueprintPath } = factoryConfig;
const base = `/repos/${repo.owner}/${repo.repo}`;

heading(`Apps repository ${repo.fullName}`);

const info = await github<{ default_branch: string }>("GET", base);
if (!info.ok || !info.body) {
	fail(
		`Cannot read ${repo.fullName} (HTTP ${info.status})`,
		"Create the repository and give the credential Contents: write on it.",
	);
}

const existing = await github(
	"GET",
	`${base}/contents/${blueprintPath}?ref=${encodeURIComponent(branch)}`,
);
if (existing.ok) {
	print({
		level: "ok",
		message: `${branch}:${blueprintPath} already exists, so nothing changed`,
	});
} else {
	// An empty repository has no branch yet. A commit without a branch name
	// creates the default branch, so it must be the branch the factory uses.
	const hasBranch = (
		await github("GET", `${base}/branches/${encodeURIComponent(branch)}`)
	).ok;
	if (!hasBranch && info.body.default_branch !== branch) {
		fail(
			`${repo.fullName} has no branch ${branch}`,
			`Create it, or set branch in factory.config.ts to ${info.body.default_branch}.`,
		);
	}

	const created = await github("PUT", `${base}/contents/${blueprintPath}`, {
		message: "Add the empty apps Blueprint",
		content: Buffer.from(rootBlueprint([])).toString("base64"),
		...(hasBranch ? { branch } : {}),
	});
	if (!created.ok) {
		fail(
			`Could not commit ${blueprintPath} (HTTP ${created.status})`,
			"The credential needs Contents: write on the apps repository.",
		);
	}
	print({ level: "ok", message: `Committed ${branch}:${blueprintPath}` });
}

heading("Next: connect the apps Blueprint, once");
const workspace = process.env.RENDER_WORKSPACE_ID ?? "RENDER_WORKSPACE_ID";
console.log(`  In the Render Dashboard for workspace ${workspace}:`);
console.log(`  ${bold("New > Blueprint")}, repository ${bold(repo.fullName)},`);
console.log(`  branch ${bold(branch)}, Blueprint Path ${bold(blueprintPath)}.`);
console.log(`  ${dim("Keep Auto Sync on. npm run doctor confirms it.")}`);

exitWith([{ level: "ok", message: "The apps repository is ready." }]);

async function github<T = unknown>(
	method: "GET" | "PUT",
	path: string,
	body?: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; body: T | null }> {
	const response = await fetch(`${API}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "vibe-factory-setup",
		},
		body: body ? JSON.stringify(body) : undefined,
		signal: AbortSignal.timeout(15_000),
	});
	return {
		ok: response.ok,
		status: response.status,
		body: response.ok ? ((await response.json()) as T) : null,
	};
}

function fail(message: string, fix: string): never {
	print({ level: "fail", message, fix });
	return exitWith([{ level: "fail", message }]);
}
