/**
 * Diagnose a deployment without changing anything.
 *
 * Every check reports what is wrong and how to fix it. Read-only by design:
 * it never creates or edits a resource.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { factoryConfig } from "../factory.config.js";
import {
	apiKey,
	appsRepo,
	renderWorkspaceId,
	uiCredentials,
} from "../app/config.js";
import { githubToken, usingGitHubApp } from "../app/github.js";
import { RENDER_READ_ONLY_TOOLS } from "../app/policy.js";
import { findBlueprint, renderMcpUrl } from "../app/render.js";
import { db } from "../app/store.js";
import { exitWith, type Finding, heading, print } from "./support.js";

const API = process.env.GITHUB_API_URL ?? "https://api.github.com";
const ANTHROPIC_API = (
	process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"
).replace(/\/+$/, "");
const findings: Finding[] = [];

function record(finding: Finding): void {
	findings.push(finding);
	print(finding);
}

function present(name: string, fix: string): boolean {
	if (process.env[name]?.trim()) {
		record({ level: "ok", message: `${name} is set` });
		return true;
	}
	record({ level: "fail", message: `${name} is missing`, fix });
	return false;
}

async function github<T>(
	path: string,
	token: string,
): Promise<{ ok: boolean; status: number; body: T | null }> {
	try {
		const response = await fetch(`${API}${path}`, {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
				"User-Agent": "vibe-factory-doctor",
			},
			signal: AbortSignal.timeout(15_000),
		});
		const body = response.ok ? ((await response.json()) as T) : null;
		return { ok: response.ok, status: response.status, body };
	} catch {
		return { ok: false, status: 0, body: null };
	}
}

/**
 * Run a validator of app/config.ts, the same one that a process runs when it
 * starts, and record its message or its error.
 */
function validate(check: () => string, fix: string): void {
	try {
		record({ level: "ok", message: check() });
	} catch (error) {
		record({
			level: "fail",
			message: error instanceof Error ? error.message : String(error),
			fix,
		});
	}
}

function checkConfiguration(): void {
	heading("Configuration");

	validate(
		() => `APPS_REPO is ${appsRepo().fullName}`,
		"Use owner/repo format.",
	);
	validate(() => {
		apiKey();
		return "FACTORY_API_KEY looks strong";
	}, "Generate one with: openssl rand -hex 32");
	validate(
		() => `UI_USERNAME namespaces apps as ${uiCredentials().username}`,
		"UI_USERNAME needs 3-31 lowercase letters, numbers, or hyphens, and UI_PASSWORD at least 16 characters.",
	);

	// The gateway needs this to dispatch, not just the workflows host.
	present(
		"RENDER_API_KEY",
		"Required by both processes; the gateway uses it to dispatch tasks.",
	);
	present(
		"RENDER_WORKFLOW_SLUG",
		"Set it to the Workflows service slug, without a task name.",
	);
	present("DATABASE_URL", "Both processes must point at the same database.");
	present("ANTHROPIC_API_KEY", "Required by the workflows host.");
	present("RENDER_WORKSPACE_ID", "Required to create sandboxes.");

	if (usingGitHubApp()) {
		record({ level: "ok", message: "GitHub App credentials configured" });
	} else if (process.env.GITHUB_TOKEN?.trim()) {
		record({
			level: "warn",
			message: "Using a personal access token",
			fix: "Commits will be attributed to the token's owner. A GitHub App scoped to APPS_REPO is tidier.",
		});
	} else {
		record({
			level: "fail",
			message: "No GitHub credentials",
			fix: "Set GITHUB_TOKEN, or the GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY / GITHUB_APP_INSTALLATION_ID trio.",
		});
	}
}

async function checkModels(): Promise<void> {
	heading("Models");

	const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
	if (!apiKey) {
		record({ level: "warn", message: "Skipped — ANTHROPIC_API_KEY is not set" });
		return;
	}

	for (const model of new Set(Object.values(factoryConfig.models))) {
		try {
			const response = await fetch(
				`${ANTHROPIC_API}/v1/models/${encodeURIComponent(model)}`,
				{
					headers: {
						"x-api-key": apiKey,
						"anthropic-version": "2023-06-01",
					},
					signal: AbortSignal.timeout(15_000),
				},
			);
			record(
				response.ok
					? { level: "ok", message: `Anthropic model ${model} is available` }
					: {
							level: "fail",
							message: `Anthropic model ${model} is unavailable (HTTP ${response.status})`,
							fix: "Choose a model ID returned by GET /v1/models and update factory.config.ts.",
						},
			);
		} catch (error) {
			record({
				level: "fail",
				message: `Could not check Anthropic model ${model}`,
				fix: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

async function checkGitHub(): Promise<void> {
	heading("Apps repository");

	let token: string;
	try {
		token = await githubToken();
	} catch (error) {
		record({
			level: "fail",
			message: "Could not obtain a GitHub token",
			fix: error instanceof Error ? error.message : undefined,
		});
		return;
	}

	let repo: ReturnType<typeof appsRepo>;
	try {
		repo = appsRepo();
	} catch {
		record({
			level: "warn",
			message: "Skipped — APPS_REPO is not usable",
			fix: "Fix APPS_REPO above, then run this again.",
		});
		return;
	}

	const base = `/repos/${repo.owner}/${repo.repo}`;
	const info = await github<{
		permissions?: Record<string, boolean>;
		default_branch?: string;
	}>(base, token);
	if (!info.ok) {
		record({
			level: "fail",
			message: `Cannot read ${repo.fullName} (HTTP ${info.status || "network error"})`,
			fix: "Create the repository and scope the credential to it.",
		});
		return;
	}
	record({ level: "ok", message: `Can read ${repo.fullName}` });

	const permissions = info.body?.permissions;
	if (permissions && !permissions.push) {
		record({
			level: "fail",
			message: "Credential cannot push",
			fix: "Grant Contents: write so the factory can commit generated apps.",
		});
	} else if (permissions) {
		record({ level: "ok", message: "Credential can push" });
	}

	const branch = info.body?.default_branch;
	record(
		branch === factoryConfig.branch
			? { level: "ok", message: `Default branch is ${branch}` }
			: {
					level: "warn",
					message: `Default branch is ${branch ?? "unknown"}, but the factory pushes to ${factoryConfig.branch}`,
					fix: `Set branch in factory.config.ts to ${branch}, or point the Blueprint at ${factoryConfig.branch}.`,
				},
	);
}

async function checkBlueprint(): Promise<void> {
	heading("Blueprint");

	if (
		!process.env.RENDER_API_KEY?.trim() ||
		!process.env.RENDER_WORKSPACE_ID?.trim()
	) {
		record({
			level: "warn",
			message: "Skipped — RENDER_API_KEY or RENDER_WORKSPACE_ID is not set",
			fix: "Set them, then run this again.",
		});
		return;
	}

	let repo: ReturnType<typeof appsRepo>;
	try {
		repo = appsRepo();
	} catch {
		record({ level: "warn", message: "Skipped — APPS_REPO is not usable" });
		return;
	}

	const workspaceId = renderWorkspaceId();
	try {
		const blueprint = await findBlueprint({
			workspaceId,
			repo: repo.url,
			branch: factoryConfig.branch,
			path: factoryConfig.blueprintPath,
		});
		if (!blueprint) {
			record({
				level: "fail",
				message: `No Blueprint in workspace ${workspaceId} watches ${repo.fullName} (${factoryConfig.branch}:${factoryConfig.blueprintPath})`,
				fix:
					"Run npm run setup:apps-repo, then create the Blueprint once in that workspace in the Render " +
					`Dashboard: New > Blueprint, pick the apps repository, branch ${factoryConfig.branch}, ` +
					`Blueprint Path ${factoryConfig.blueprintPath}. Until then runs commit their app but stop at awaiting_blueprint.`,
			});
			return;
		}

		record({
			level: "ok",
			message: `Blueprint ${blueprint.id} is watching, status "${blueprint.status}"`,
		});
		record(
			blueprint.autoSync
				? { level: "ok", message: "Auto Sync is on, so a push deploys" }
				: {
						level: "fail",
						message: "Auto Sync is off",
						fix: "Turn it on in the Blueprint's Settings, or every run will need a manual sync.",
					},
		);
	} catch (error) {
		record({
			level: "fail",
			message: "Could not list Blueprints",
			fix: error instanceof Error ? error.message : undefined,
		});
	}
}

/**
 * The architect reads Render through the MCP server. If the server lacks a
 * tool on the allowlist, or the tool cannot name a workspace, the architect
 * silently loses it.
 */
async function checkRenderMcp(): Promise<void> {
	heading("Render MCP");

	const apiKey = process.env.RENDER_API_KEY?.trim();
	if (!apiKey) {
		record({ level: "warn", message: "Skipped — RENDER_API_KEY is not set" });
		return;
	}

	const client = new Client({ name: "vibe-factory-doctor", version: "0.1.0" });
	try {
		await client.connect(
			new StreamableHTTPClientTransport(new URL(renderMcpUrl()), {
				requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
			}),
		);
		const tools = new Map<string, string[]>();
		let cursor: string | undefined;
		do {
			const page = await client.listTools({ cursor });
			for (const tool of page.tools) {
				tools.set(tool.name, Object.keys(tool.inputSchema.properties ?? {}));
			}
			cursor = page.nextCursor;
		} while (cursor);

		const missing = RENDER_READ_ONLY_TOOLS.filter((name) => !tools.has(name));
		const unpinnable = RENDER_READ_ONLY_TOOLS.filter(
			(name) => tools.has(name) && !tools.get(name)?.includes("workspaceId"),
		);
		record(
			missing.length > 0
				? {
						level: "fail",
						message: `The Render MCP server has no tool named ${missing.join(", ")}`,
						fix: "Change RENDER_READ_ONLY_TOOLS in app/policy.ts to the names that the server uses.",
					}
				: unpinnable.length > 0
					? {
							level: "fail",
							message: `These Render MCP tools take no workspaceId: ${unpinnable.join(", ")}`,
							fix: "Remove them from RENDER_READ_ONLY_TOOLS in app/policy.ts. Without a workspace, a call fails or reads the wrong one.",
						}
					: {
							level: "ok",
							message: `MCP reachable, with the ${RENDER_READ_ONLY_TOOLS.length} read-only tools that the agents use`,
						},
		);

		const workspaceId = process.env.RENDER_WORKSPACE_ID?.trim();
		if (workspaceId) {
			const result = await client.callTool({
				name: "list_services",
				arguments: { workspaceId },
			});
			record(
				result.isError
					? {
							level: "fail",
							message: `The Render MCP server cannot read workspace ${workspaceId}`,
							fix: "Use a RENDER_API_KEY that can reach RENDER_WORKSPACE_ID.",
						}
					: {
							level: "ok",
							message: `The Render MCP server reads workspace ${workspaceId}`,
						},
			);
		}
	} catch (error) {
		record({
			level: "fail",
			message: "Cannot reach the Render MCP server",
			fix: error instanceof Error ? error.message : undefined,
		});
	} finally {
		await client.close().catch(() => {});
	}
}

async function checkPostgres(): Promise<void> {
	heading("Postgres");

	if (!process.env.DATABASE_URL?.trim()) {
		record({
			level: "warn",
			message: "Skipped — DATABASE_URL is not set",
			fix: "Set it, then run this again.",
		});
		return;
	}

	try {
		const { rows } = await db().query<{ column_name: string }>(
			`select column_name from information_schema.columns
			 where table_schema = 'public' and table_name = 'runs'`,
		);
		if (rows.length === 0) {
			record({
				level: "fail",
				message: "The runs table does not exist",
				fix: "Apply the schema with npm run db:migrate.",
			});
			return;
		}
		record({ level: "ok", message: "Connected, runs table present" });

		const columns = new Set(rows.map((row) => row.column_name));
		const missing = [
			"id",
			"idempotency_key",
			"prompt",
			"user_name",
			"status",
			"progress",
			"workflow_run_id",
			"web_url",
			"blueprint_path",
			"sandbox_id",
			"sandbox_group_id",
			"finished_at",
			"stage_history",
		].filter((name) => !columns.has(name));
		record(
			missing.length === 0
				? { level: "ok", message: "runs has the expected columns" }
				: {
						level: "fail",
						message: `runs is missing: ${missing.join(", ")}`,
						fix: "Apply the additive migration with npm run db:migrate.",
					},
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// Render's external connection string omits sslmode; the internal one
		// the deployed services use does not need it.
		const fix = /ssl/i.test(message)
			? `${message}. Append ?sslmode=require when connecting to a Render database from outside Render.`
			: message;
		record({ level: "fail", message: "Cannot reach Postgres", fix });
	}
}

async function checkTasks(): Promise<void> {
	heading("Task registration");

	try {
		const { TaskRegistry } = await import("@renderinc/sdk/workflows");
		await import("../app/agents.js");
		await import("../app/workflow.js");

		const registered = new Set(TaskRegistry.getInstance().getAllTaskNames());
		const expected = [
			"architect",
			"builder",
			"prompt-to-app",
			"verify-app",
			"publish-app",
			"delete-app",
			"remove-app-from-blueprint",
			"wait-for-blueprint-syncs",
			"delete-app-resources",
			"remove-app-files",
		];
		const missing = expected.filter((name) => !registered.has(name));

		record(
			missing.length === 0
				? { level: "ok", message: `All ${expected.length} tasks registered` }
				: {
						level: "fail",
						message: `Not registered: ${missing.join(", ")}`,
						fix: "Every agent must be wrapped with agentTask() in app/agents.ts, and prompt-to-app, verify-app, publish-app, delete-app, and the four steps of delete-app defined in app/workflow.ts and its stage modules.",
					},
		);
	} catch (error) {
		record({
			level: "fail",
			message: "Could not load task registrations",
			fix: error instanceof Error ? error.message : undefined,
		});
	}
}

checkConfiguration();
await checkModels();
await checkGitHub();
await checkBlueprint();
await checkRenderMcp();
await checkPostgres();
await checkTasks();

// Only close a pool that was actually opened.
if (process.env.DATABASE_URL?.trim()) {
	await db()
		.end()
		.catch(() => {});
}
exitWith(findings);
