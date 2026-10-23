/**
 * The four steps of delete-app. removeApp() in app/workflow.ts runs them in
 * order and explains why the order matters.
 */
import { type TaskContext, task } from "@renderinc/sdk/workflows";
import {
	appPath,
	appRelativePath,
	factoryConfig,
} from "../factory.config.js";
import { appsRepo, renderWorkspaceId } from "./config.js";
import {
	type AppSpec,
	appSpecSchema,
	type DeleteAppInput,
	type DeleteResourcesInput,
	deleteAppInputSchema,
	deleteResourcesInputSchema,
	type WaitForSyncsInput,
	waitForSyncsInputSchema,
} from "./contracts.js";
import { commitAndPush, inAppsClone, writeRootBlueprint } from "./publish.js";
import { findBlueprint } from "./render.js";
import { type Sandbox, shellEscape } from "./sandbox.js";
import { setDeleteProgress } from "./store.js";
import { deleteAppResources, waitForBlueprintSyncs } from "./teardown.js";

/** Each delete step makes one push, waits for Blueprint syncs, or deletes resources. */
export const DELETE_STEP_TIMEOUT_SECONDS = 10 * 60;
/** How long an unfinished apps Blueprint sync may run before the delete gives up. */
const SYNC_TIMEOUT_MS = 6 * 60 * 1000;

/**
 * Render does not retry a step: a failed step fails the delete, and the next
 * attempt starts again at the first step. A retried first step would find
 * nothing to commit after its push, so the wait would not know when the push
 * happened. A retried wait would give a sync more than SYNC_TIMEOUT_MS.
 */
const DELETE_STEP = {
	plan: "flex",
	timeoutSeconds: DELETE_STEP_TIMEOUT_SECONDS,
	retry: { maxRetries: 0, waitDurationMs: 0 },
};

interface RemovedFromBlueprint {
	/** From factory.json. Every Render resource name of the app starts with it. */
	resourcePrefix: string;
	/** The commit that took the app out, or null if an earlier attempt pushed it. */
	commit: string | null;
	/** When this attempt pushed that commit, or null. */
	pushedAt: number | null;
}

/**
 * Write deletedAt into the app's factory.json, and push a root Blueprint that
 * leaves the app out. The commit changes only these two files: removing a
 * service's source would start a build of it, and that build would fail
 * before the service is deleted.
 *
 * Returns null when the repository has no spec for the app. Only the spec
 * names the resources, so then no step deletes anything on Render.
 */
export const removeFromBlueprintTask = task(
	{ name: "remove-app-from-blueprint", ...DELETE_STEP },
	async function removeFromBlueprint(
		_tasks: TaskContext,
		input: DeleteAppInput,
	): Promise<RemovedFromBlueprint | null> {
		const { user, appName } = deleteAppInputSchema.parse(input);
		await setDeleteProgress(
			user,
			appName,
			"Removing the app from the Blueprint",
		);

		return inAppsClone(DELETE_STEP_TIMEOUT_SECONDS, async (clone) => {
			const spec = await readSpec(clone.sandbox, user, appName);
			if (!spec) {
				console.log(
					JSON.stringify({ event: "app_spec_not_found", user, appName }),
				);
				return null;
			}

			const deleting: AppSpec = {
				...spec,
				deletedAt: spec.deletedAt ?? new Date().toISOString(),
			};
			const commit = await commitAndPush(
				clone,
				{ user, appName },
				`Delete ${user}/${appName}: remove it from the Blueprint`,
				async () => {
					await clone.sandbox.writeFile(
						`${appPath(user, appName)}/factory.json`,
						`${JSON.stringify(deleting, null, 2)}\n`,
					);
					await writeRootBlueprint(clone.sandbox);
				},
			);
			const pushedAt = commit ? Date.now() : null;
			console.log(
				JSON.stringify({
					event: "app_removed_from_blueprint",
					user,
					appName,
					deletedAt: deleting.deletedAt,
					commit,
				}),
			);
			return { resourcePrefix: spec.resourcePrefix, commit, pushedAt };
		});
	},
);

/**
 * Wait until no apps Blueprint sync is pending or running. When no Blueprint
 * watches the apps repository, no sync can bring a resource back, so there is
 * nothing to wait for.
 */
export const waitForSyncsTask = task(
	{ name: "wait-for-blueprint-syncs", ...DELETE_STEP },
	async function waitForSyncs(
		_tasks: TaskContext,
		input: WaitForSyncsInput,
	): Promise<{ blueprintId: string | null }> {
		const { user, appName, pushedAt } = waitForSyncsInputSchema.parse(input);
		const target = {
			workspaceId: renderWorkspaceId(),
			repo: appsRepo().url,
			branch: factoryConfig.branch,
			path: factoryConfig.blueprintPath,
		};
		// An error stops the delete. A delete without the wait for the
		// Blueprint lets a sync bring the resources back.
		const blueprint = await findBlueprint(target);
		if (!blueprint) {
			console.warn(JSON.stringify({ event: "blueprint_not_found", ...target }));
			return { blueprintId: null };
		}

		await waitForBlueprintSyncs(blueprint.id, {
			pushedAt,
			timeoutMs: SYNC_TIMEOUT_MS,
			onProgress: (detail) => setDeleteProgress(user, appName, detail),
		});
		return { blueprintId: blueprint.id };
	},
);

/** Delete the app's services, then its databases, then its project. */
export const deleteResourcesTask = task(
	{ name: "delete-app-resources", ...DELETE_STEP },
	async function deleteResources(
		_tasks: TaskContext,
		input: DeleteResourcesInput,
	): Promise<string[]> {
		const app = deleteResourcesInputSchema.parse(input);
		return deleteAppResources(app, {
			workspaceId: renderWorkspaceId(),
			onProgress: (detail) => setDeleteProgress(app.user, app.appName, detail),
		});
	},
);

/** Remove the app's directory from the apps repository. */
export const removeFilesTask = task(
	{ name: "remove-app-files", ...DELETE_STEP },
	async function removeFiles(
		_tasks: TaskContext,
		input: DeleteAppInput,
	): Promise<{ commit: string | null }> {
		const { user, appName } = deleteAppInputSchema.parse(input);
		await setDeleteProgress(
			user,
			appName,
			"Removing the app's files from the apps repository",
		);

		return inAppsClone(DELETE_STEP_TIMEOUT_SECONDS, async (clone) => {
			const commit = await commitAndPush(
				clone,
				{ user, appName },
				`Delete ${user}/${appName}`,
				async () => {
					await clone.sandbox.mustRun(
						`rm -rf ${shellEscape(appPath(user, appName))}`,
						"Remove the app directory",
					);
				},
			);
			console.log(
				JSON.stringify({ event: "app_files_removed", user, appName, commit }),
			);
			return { commit };
		});
	},
);

/**
 * One app's spec in the clone, or null when the repository has none. The
 * resource names to delete come from this file, so a file that names a
 * different app stops the delete.
 */
async function readSpec(
	sandbox: Sandbox,
	user: string,
	appName: string,
): Promise<AppSpec | null> {
	const path = `${appPath(user, appName)}/factory.json`;
	const exists = await sandbox.run(`test -e ${shellEscape(path)}`);
	if (exists.exitCode !== 0) return null;

	const raw = await sandbox.readFile(path);
	let value: unknown = null;
	try {
		value = JSON.parse(raw);
	} catch {
		// Reported below with the schema failure.
	}
	const parsed = appSpecSchema.safeParse(value);
	if (
		!parsed.success ||
		parsed.data.user !== user ||
		parsed.data.appName !== appName
	) {
		throw new Error(
			`${appRelativePath(user, appName)}/factory.json is not a valid spec of ${user}/${appName}, so the delete stopped.`,
		);
	}
	return parsed.data;
}
