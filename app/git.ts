/**
 * Clone, commit, push, verify — all workflow-owned. Agents never run git.
 *
 * The build sandbox gets no clone and no credential. The factory copies the
 * app's files out of it as data (files.ts) and commits them in a clone in a
 * different sandbox. Each commit changes only one app's directory and the
 * root Blueprint.
 */
import { randomUUID } from "node:crypto";
import { factoryConfig } from "../factory.config.js";
import type { Manifest } from "./contracts.js";
import { type ExecResult, type Sandbox, shellEscape } from "./sandbox.js";

export const REPO_DIR = factoryConfig.repoDir;

const GITHUB_SEGMENT = /^[A-Za-z0-9_.-]+$/;
/** A path segment that a .gitignore pattern matches literally: no globs, no escapes. */
const PLAIN_SEGMENT = /^[A-Za-z0-9._-]+$/;
const PUSH_ATTEMPTS = 3;

export function githubRemoteUrl(owner: string, repo: string): string {
	const unsafe = [owner, repo].some(
		(part) => !GITHUB_SEGMENT.test(part) || part === "." || part === "..",
	);
	if (unsafe) {
		throw new Error(
			"GitHub owner and repository must contain only safe characters",
		);
	}
	return `https://github.com/${owner}/${repo}.git`;
}

/** Run a git subcommand in the clone. Disables repo hooks for safety. */
export function git(
	sandbox: Sandbox,
	subcommand: string,
	label: string,
): Promise<string> {
	return sandbox.mustRun(
		`git -c core.hooksPath=/dev/null -C ${shellEscape(REPO_DIR)} ${subcommand}`,
		label,
	);
}

/**
 * Run one authenticated Git command. The token reaches Git through a
 * temporary GIT_ASKPASS script so it never appears in .git/config or the
 * process listing.
 */
export async function execGitWithToken(
	sandbox: Sandbox,
	token: string,
	args: readonly string[],
): Promise<ExecResult> {
	if (args[0] !== "git") {
		throw new Error("execGitWithToken accepts only git commands");
	}

	const askpassPath = `/tmp/vibe-askpass-${randomUUID()}.sh`;
	// x-access-token is what GitHub expects for App installation tokens, and is
	// accepted as the username for a PAT too.
	await sandbox.upload(
		askpassPath,
		`#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' 'x-access-token' ;;
  *Password*) printf '%s\\n' ${shellEscape(token)} ;;
  *) exit 1 ;;
esac
`,
	);

	try {
		const command = [
			"git",
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"credential.helper=",
			...args.slice(1),
		]
			.map(shellEscape)
			.join(" ");

		return await sandbox.run(
			`chmod 700 ${shellEscape(askpassPath)} && ` +
				`GIT_ASKPASS=${shellEscape(askpassPath)} GIT_TERMINAL_PROMPT=0 ${command}`,
		);
	} finally {
		await sandbox.run(`rm -f ${shellEscape(askpassPath)}`).catch(() => {});
	}
}

/**
 * Clone the apps repository. Every run works on the shared branch the
 * Blueprint tracks, because appending to that Blueprint is what deploys.
 *
 * The token enters the sandbox, so the sandbox must be one that no agent has
 * used.
 */
export async function cloneAppsRepo(
	sandbox: Sandbox,
	token: string,
	repo: { owner: string; repo: string },
	branch: string,
): Promise<string> {
	const remoteUrl = githubRemoteUrl(repo.owner, repo.repo);
	const clone = await execGitWithToken(sandbox, token, [
		"git",
		"clone",
		"--depth=1",
		// A symbolic link in the repository becomes a plain file that holds its
		// target. So no write of the factory can follow a link out of the
		// clone, for example to put a different git on the PATH before the push.
		"--config",
		"core.symlinks=false",
		remoteUrl,
		REPO_DIR,
	]);
	if (clone.exitCode !== 0) {
		throw new Error(`Clone failed: ${clone.output.slice(0, 500)}`);
	}

	// -B rather than checkout so a repository with no commits yet works.
	await git(sandbox, `checkout -B ${shellEscape(branch)}`, "Select branch");
	await git(sandbox, 'config user.name "vibe-factory[bot]"', "Set commit name");
	await git(
		sandbox,
		'config user.email "bot@vibe-factory.dev"',
		"Set commit email",
	);
	return remoteUrl;
}

/**
 * The .gitignore at the root of each app. Render builds every service from a
 * fresh clone, and its buildCommand installs the dependencies and writes the
 * directory a static site publishes. A commit does not need them.
 *
 * The manifest is agent-authored, so a publish directory gets a rule only when
 * it is a plain path below the service's rootDir. "." publishes the source of
 * the service itself, which is how a site without a build works. Every other
 * path gets no rule: a missing rule commits too much, but a wrong rule removes
 * a file that the deploy needs.
 */
export function appGitignore(manifest: Manifest): string {
	const publishDirs = new Set<string>();
	for (const service of manifest.services) {
		// Render reads staticPublishPath only for a static site.
		if (service.kind !== "static_site" || !service.staticPublishPath) continue;
		const rootDir = plainPath(service.rootDir);
		const publishDir = plainPath(service.staticPublishPath);
		if (rootDir === null || !publishDir) continue;
		// Anchored, so that a source directory with the same name deeper in
		// the app stays in the commit.
		publishDirs.add(`/${rootDir ? `${rootDir}/` : ""}${publishDir}/`);
	}

	return [
		"# Generated by vibe-coding-app. Do not edit by hand.",
		"# Render builds each service from a fresh clone. Its buildCommand makes",
		"# these paths, so a commit does not need them.",
		"node_modules/",
		...[...publishDirs].sort(),
		"",
	].join("\n");
}

/**
 * An agent-supplied relative path as "a/b", "" for the directory itself, or
 * null when it is not a plain relative path.
 */
function plainPath(path: string): string | null {
	if (path.startsWith("/")) return null;
	const segments = path
		.split("/")
		.filter((segment) => segment !== "" && segment !== ".");
	const plain = segments.every(
		(segment) => segment !== ".." && PLAIN_SEGMENT.test(segment),
	);
	return plain ? segments.join("/") : null;
}

/**
 * Delete everything git ignores in a directory. What stays is what a commit
 * holds, which is all Render's fresh clone gets. -X, not -x: an untracked
 * file that is not ignored is part of the app, so it stays.
 */
export async function removeIgnored(
	sandbox: Sandbox,
	dir: string,
): Promise<void> {
	await sandbox.mustRun(
		`git -c core.hooksPath=/dev/null -C ${shellEscape(dir)} clean -fdXq -- .`,
		"Remove ignored files",
	);
}

/**
 * Commit the changes below the given paths, which are relative to the root of
 * the clone. A change to a different path stays out of the commit. Returns
 * null when nothing changed.
 */
export async function commitPaths(
	sandbox: Sandbox,
	message: string,
	paths: readonly string[],
): Promise<string | null> {
	// git add fails for a path that matches no file, for example the
	// directory of an app that an earlier attempt of its delete removed. So
	// stage all, and then unstage all other paths.
	await git(sandbox, "add -A", "Git add");
	const others = [":(top)", ...paths.map((path) => `:(exclude,literal)${path}`)];
	await git(
		sandbox,
		`reset -q -- ${others.map(shellEscape).join(" ")}`,
		"Unstage other paths",
	);

	const staged = await sandbox.run(
		`git -C ${shellEscape(REPO_DIR)} diff --cached --quiet`,
	);
	if (staged.exitCode === 0) return null;
	if (staged.exitCode !== 1) {
		throw new Error(`Git diff check failed: ${staged.output.slice(0, 500)}`);
	}

	await git(sandbox, `commit -q -m ${shellEscape(message)}`, "Commit");
	return (await git(sandbox, "rev-parse HEAD", "Committed revision")).trim();
}

/**
 * Push the commit at HEAD to the shared branch, then confirm that the remote
 * holds it. Render deploys from this branch, so a mismatch here would mean
 * deploying something unverified.
 *
 * When the push fails, for example because another run pushed first, the
 * clone takes the new tip of the branch, and `redo` makes the same change
 * and commit on it. Each change of the factory is derived from its inputs,
 * so it applies to any tip, and no merge is necessary. `redo` returns the
 * new commit, or null when the tip already holds the change.
 *
 * The push stops before it sends a commit that changes a path outside
 * `paths`, which are relative to the root of the clone.
 */
export async function pushVerified(
	sandbox: Sandbox,
	token: string,
	remoteUrl: string,
	branch: string,
	paths: readonly string[],
	redo: () => Promise<string | null>,
): Promise<string> {
	const ref = `refs/heads/${branch}`;

	for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
		// Before each attempt, because a new attempt makes a new commit.
		await checkCommitPaths(sandbox, paths);
		const push = await execGitWithToken(sandbox, token, [
			"git",
			"-C",
			REPO_DIR,
			"push",
			remoteUrl,
			`HEAD:${ref}`,
		]);
		if (push.exitCode === 0) break;

		if (attempt === PUSH_ATTEMPTS) {
			throw new Error(`Push failed: ${push.output.slice(0, 500)}`);
		}
		await takeTip(sandbox, token, remoteUrl, branch);
		// A push can reach the remote although git reports a failure. Then
		// the tip that the clone took already holds the change.
		if (!(await redo())) return headRevision(sandbox);
	}

	const head = await headRevision(sandbox);
	const remote = await execGitWithToken(sandbox, token, [
		"git",
		"ls-remote",
		remoteUrl,
		ref,
	]);
	if (remote.exitCode !== 0) {
		throw new Error(`Push verification failed: ${remote.output.slice(0, 500)}`);
	}
	if (remote.output.trim().split(/\s+/)[0] !== head) {
		throw new Error("Pushed branch SHA does not match the local commit");
	}
	return head;
}

/**
 * Set the clone to the newest commit of the branch. This drops the commit
 * of the failed push, and its change in the files that the clone tracks.
 */
async function takeTip(
	sandbox: Sandbox,
	token: string,
	remoteUrl: string,
	branch: string,
): Promise<void> {
	const fetched = await execGitWithToken(sandbox, token, [
		"git",
		"-C",
		REPO_DIR,
		"fetch",
		"-q",
		"--depth=1",
		remoteUrl,
		branch,
	]);
	if (fetched.exitCode !== 0) {
		throw new Error(`Fetch of ${branch} failed: ${fetched.output.slice(0, 500)}`);
	}
	await git(sandbox, "reset -q --hard FETCH_HEAD", "Take the tip of the branch");
}

async function headRevision(sandbox: Sandbox): Promise<string> {
	return (await git(sandbox, "rev-parse HEAD", "Pushed revision")).trim();
}

/**
 * Refuse a commit that changes a path outside `paths`. A push adds one
 * commit, at HEAD: commitPaths() makes it on the tip of the clone.
 */
async function checkCommitPaths(
	sandbox: Sandbox,
	paths: readonly string[],
): Promise<void> {
	const outside = (await headChangedPaths(sandbox)).filter(
		(changed) =>
			!paths.some((path) => changed === path || changed.startsWith(`${path}/`)),
	);
	if (outside.length > 0) {
		throw new Error(
			`The commit changes paths outside ${paths.join(" and ")}, so it was not pushed: ${outside.slice(0, 10).join(", ")}`,
		);
	}
}

/** The paths that the commit at HEAD changes, relative to the root of the clone. */
export async function headChangedPaths(sandbox: Sandbox): Promise<string[]> {
	// -m, so that a merge commit also shows what it changes.
	const listed = await git(
		sandbox,
		"diff-tree -m -r -z --root --no-renames --no-commit-id --name-only HEAD",
		"List the paths that the commit changes",
	);
	// Each path ends with a NUL. Without them, two paths would join into one
	// that can start with an allowed path.
	if (listed !== "" && !listed.endsWith("\0")) {
		throw new Error(
			`The list of the paths that the commit changes has no NUL terminators: ${listed.slice(0, 200)}`,
		);
	}
	return listed.split("\0").filter((path) => path !== "");
}

/**
 * Create the app directory in the build sandbox, inside a new repository with
 * no remote. The sandbox gets no clone of the apps repository and no
 * credential. Git there only decides which files a commit would hold:
 * removeIgnored() deletes the rest, and readAppFiles() packs these.
 */
export async function initAppDir(
	sandbox: Sandbox,
	appDir: string,
): Promise<void> {
	await sandbox.mustRun(
		`git init -q ${shellEscape(REPO_DIR)} && mkdir -p ${shellEscape(appDir)}`,
		"Create the app directory",
	);
}
