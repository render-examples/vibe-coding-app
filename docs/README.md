# vibe-code-demo documentation

Start with the document that matches what you want to do:

| Document | Read it to |
| --- | --- |
| [README](../README.md) | Learn what this is and why it matters, and get it running |
| [Quickstart](QUICKSTART.md) | Set up, run, deploy, clean up, and customize the factory |
| [Walkthrough](WALKTHROUGH.md) | Tour the code by following one run end to end |
| [Takeaways](TAKEAWAYS.md) | Get the reusable patterns, and where each lives in the code |
| [FAQ for field engineering](FAQ.md) | Run a live demo and answer common questions |
| [AGENTS.md](../AGENTS.md) | Change the code: conventions, invariants, and checklists |

The rest of this page is the operational reference: configuration, the HTTP
API, troubleshooting, deleting apps, and current limitations.

**Contents:**
[When to use this](#when-to-use-this-reference) ·
[Configuration](#configuration) ·
[HTTP API](#http-api) ·
[Run statuses](#run-statuses) ·
[Troubleshooting](#troubleshooting-a-stuck-run) ·
[Delete an app](#delete-an-app) ·
[Log events](#log-events) ·
[Safety boundaries](#safety-boundaries) ·
[Limitations](#current-limitations)

## When to use this reference

Use vibe-code-demo when you want to:

- see an agent take an idea all the way to a deployed multi-service app,
  not stop at generated code,
- show infrastructure created only through committed Blueprints, while agents
  inspect the platform through read-only tools, or
- show checks both before the deploy (in a sandbox) and after it (against
  the live frontend, API, database, and CORS).

Do not expose it unchanged to untrusted users. The gateway has one Basic Auth
user and one shared API token, one apps repository and branch, a small
concurrency cap, and no per-tenant quotas.

## Configuration

Environment variables. `.env.example` has the same list with comments.

| Variable | Read by | Purpose |
| --- | --- | --- |
| `APPS_REPO` | Workflows | The one repository generated apps are committed to, as `owner/repo`. `render.yaml` also asks for it on the gateway, which does not read it. |
| `DATABASE_URL` | Both | Postgres connection string for the `runs` table |
| `RENDER_API_KEY` | Both | The gateway starts tasks with it. The workflows host uses it for Sandboxes, the agents' MCP connection, reads of services, deploys, logs, and Blueprints, and the deletes of a deleted app's resources. |
| `FACTORY_API_KEY` | Gateway | Bearer token for `/v1/*`, at least 24 characters. The Blueprint generates it. |
| `UI_USERNAME` | Gateway | UI login, and the namespace of apps submitted from the UI. A lowercase slug. |
| `UI_PASSWORD` | Gateway | UI password, at least 16 characters |
| `UI_AUTH_DISABLED` | Gateway | `true` skips Basic Auth for local preview. Ignored when `NODE_ENV=production`. |
| `RENDER_WORKFLOW_SLUG` | Gateway | The workflow service slug, without a task name. The Blueprint sets it. |
| `PORT` | Gateway | HTTP port. Defaults to `3000`. |
| `RENDER_WORKSPACE_ID` | Workflows | The workspace (`tea-...`) for sandboxes, services, and the apps Blueprint |
| `ANTHROPIC_API_KEY` | Workflows | Claude Agent SDK credential |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID` | Workflows | GitHub App credentials, preferred over a token. The key can be PEM, PEM with escaped newlines, or base64. |
| `GITHUB_TOKEN` | Workflows | Fine-grained personal access token, used when no App is set |
| `RENDER_MCP_URL` | Workflows | Optional Render MCP endpoint. Defaults to `https://mcp.render.com/mcp`. |
| `GITHUB_API_URL` | Workflows | Optional GitHub API base URL. Defaults to `https://api.github.com`. |
| `FACTORY_GATEWAY_URL`, `FACTORY_USER` | `npm run demo` | Gateway to call, and the namespace to file apps under |

`npm run dev:gateway` sets `RENDER_USE_LOCAL_DEV=true` so the local gateway
starts tasks on the `npm run dev:workflows` server. Never put it in `.env`.

Everything else lives in `factory.config.ts`. The
[Quickstart](QUICKSTART.md#change-the-knobs-in-factoryconfigts) describes
each setting.

## HTTP API

| Route | Auth | What it does |
| --- | --- | --- |
| `GET /health` | None | Liveness |
| `GET /ready` | None | Checks Postgres; the Render health check |
| `POST /v1/apps` | Bearer | Starts a run |
| `GET /v1/apps/:runId` | Bearer | Reads a run |
| `DELETE /v1/apps/:runId` | Bearer | Deletes the run's app, with all of its runs |
| `GET`, `POST /ui/apps`; `GET`, `DELETE /ui/apps/:runId` | Basic | The same, for the browser UI. Submissions, the list, and deletes use the `UI_USERNAME` namespace. |
| `GET /`, `GET /table` | Basic | The two UI views |

`POST /v1/apps` takes JSON with `prompt` (8 to 2,000 characters), an optional
`user` (a lowercase slug, default `demo`), and an optional `idempotencyKey`.
Sending the same key again returns the first run with `duplicate: true`
instead of starting a second one. Responses:

- `202` with `runId` and `statusUrl` when the run starts,
- `429` when `maxConcurrentRuns` runs are already in progress,
- `413` when the body is over 64 KB, `400` for invalid input,
- `502` when the workflow task could not be started.

`GET /v1/apps/:runId` returns `status`, `stage`, `progress`, `stageHistory`
(when each stage started and stopped), `appName`, `urls.web`, `urls.api`,
`blueprintPath`, `summary`, timestamps, and Dashboard `links`. Summaries and
progress are redacted for secret-shaped strings.

## Run statuses

| Status | Meaning |
| --- | --- |
| `running` | The `prompt-to-app` task is working. `stage` and `progress` say where. |
| `deployed` | The app is live and passed the smoke checks |
| `awaiting_blueprint` | The app is committed, but no Blueprint watches the apps repository yet |
| `build_failed` | Verification still failed after the builder's repair rounds |
| `deploy_failed` | Render could not deploy the app, or the live app failed a smoke check |
| `failed` | The run stopped for another reason; `summary` says why |
| `deleting`, `delete_failed` | A delete of the run's app is in progress, or failed |

## Troubleshooting a stuck run

Run `npm run doctor` first. It catches most setup problems.

`GET /v1/apps/:runId` returns a coarse `stage` and a readable `progress`.
What each long stage is waiting for:

- **`verifying`**: `verify-app` is building, booting, and querying the app
  in the sandbox. If it takes more than 30 minutes, for example because a
  build command never exits, the run ends as `failed`.
- **`waiting_for_services`**: Blueprint sync has not created every expected
  service yet. After 6 minutes the run ends as `deploy_failed`. The usual
  cause is Auto Sync being off.
- **`waiting_for_deploys`**: at least one Render deploy has not finished.
  After a push that rebuilds an existing app, or after a repair push, it can
  also mean Render has not started the new deploy yet. The workflow waits only
  for a deploy newer than the one it recorded before the push. If no new
  deploy starts within 15 minutes, the run ends as `deploy_failed`.
- **`smoke_testing`**: the deploys are live, and the workflow is checking the
  public URLs, the API hostname in the storefront, the data endpoint, and
  CORS. Render can take several minutes to route a brand-new hostname, and it
  returns 404 until then. So the first check of the site and of the API health
  endpoint waits up to 10 minutes, and the data check waits up to 3 minutes.
- **`done`**: the run finished.

Every wait has a deadline and updates `progress` as it goes. When a read of
the Render API fails, the workflow tries again after 5 seconds and shows the
attempt in `progress`. Five failures in a row end the run as `failed` with the
last error in `summary`. A 401 or 403 ends it immediately, because retrying
cannot fix an API key. The Blueprint lookup works the same way, and if it
cannot finish, the run ends as `failed`, not `awaiting_blueprint`.

If the task itself crashes, times out, or is canceled before it records a
result, the row would stay `running`. The gateway prevents that: when a client
reads the run, or the UI refreshes its list, the gateway checks the task run
in Render Workflows (at most every 30 seconds per run). If the task failed or
was canceled, it marks the run `failed` and frees its concurrency slot.

In the Render Dashboard, each agent, `verify-app`, and `publish-app` is a
separate run under the `prompt-to-app` run, with its own input, result, and
logs. That is the fastest way to see which step went wrong.

## Delete an app

`DELETE /v1/apps/:runId`, or **Delete app** in the UI, deletes the app a run
built. All runs of the same app share its folder and its Render resources, so
they are all deleted together. A finished run that never claimed an app name,
for example one that failed during design, created nothing but its database
row, and the gateway deletes that row at once.

```bash
curl -X DELETE -H "Authorization: Bearer $FACTORY_API_KEY" "$GATEWAY_URL/v1/apps/$RUN_ID"
```

The gateway refuses with `409` while any run of the app is still running.
Otherwise it marks every run of the app `deleting` and starts the
`delete-app` task, which runs four steps, each a separate run in the
Dashboard:

1. **`remove-app-from-blueprint`** marks the app's `factory.json` with
   `deletedAt` and pushes a root `render.yaml` without the app. Source files
   stay for now.
2. **`wait-for-blueprint-syncs`** waits a minute for Render to receive the
   push, then until no sync of the apps Blueprint is pending or running.
3. **`delete-app-resources`** deletes the app's services, then its
   databases and their data, then its Render project. It deletes only
   resources in the app's project whose names start with `vibe-<user>-<app>-`.
4. **`remove-app-files`** removes `apps/<user>/<app>/` in a second commit.
   Then the runs are deleted.

The [Walkthrough](WALKTHROUGH.md#the-delete-flow) explains why the steps
must run in this order.

While the status is `deleting`, `progress` names the current step. When the
delete is done, `GET /v1/apps/:runId` returns `404`. The app's files remain in
the Git history of the apps repository.

A failed delete sets the runs to `delete_failed` with the reason in
`summary`. Fix the cause and send `DELETE` again; each step picks up from
whatever state the last attempt left. Two causes need you to act first:

- **A sync of the apps Blueprint did not finish in 6 minutes.** Let it
  finish, or fix it, in the Dashboard. The `wait-for-blueprint-syncs` run logs
  each unfinished sync in a `blueprint_syncs_unfinished` event.
- **The app's project holds a resource the factory did not create.** Delete
  or move it in the Dashboard. The `delete-app-resources` run logs it, with
  its ID, in a `render_resource_kept` event.

## Log events

Workflow code writes one JSON line per notable event. Search the task logs
for the `event` field.

| Task | Events |
| --- | --- |
| `prompt-to-app` | `image_skipped` (with the subject and reason); `model_json_repair`; `render_read_failed`; `deploy_logs_unavailable` |
| Agents | `agent_completed`, with the model and token counts |
| `verify-app` | `app_verified`; `app_verification_failed`, with the first line of each failure |
| `publish-app` | `app_published`, with the commit; `skipped_app_spec` for a `factory.json` the root Blueprint ignored (the delete steps that push can log it too) |
| `remove-app-from-blueprint` | `app_removed_from_blueprint`, with the commit, or `null` when an earlier attempt already pushed it; `app_spec_not_found` |
| `wait-for-blueprint-syncs` | `push_event_wait`; `blueprint_syncs_unfinished` when the set of unfinished syncs changes; `blueprint_syncs_finished`; `blueprint_not_found`; `render_read_failed` |
| `delete-app-resources` | `render_resource_deleted` and `render_resource_kept` for each resource; `render_project_not_empty`; `render_project_deleted`; `render_project_not_found` |
| `remove-app-files` | `app_files_removed`, with the commit |
| `delete-app` | `app_deleted`, with the deleted resources; `app_delete_failed`, with the error |

## Safety boundaries

The canonical list of safety rules is [Invariants in AGENTS.md](../AGENTS.md#invariants).
It is kept there, next to the conventions and checklists, so that anyone
changing the code reads it first. The [Walkthrough](WALKTHROUGH.md#trust-boundaries-in-the-code)
shows where each boundary is enforced.

## Current limitations

- **Every run costs money,** including runs started from local development:
  model tokens, a Render Sandbox, and the deployed services.
- **Generated apps keep running until you delete them.** An app with an API
  and a database leaves a web service and a Postgres instance on paid plans.
  Generated APIs and databases use paid plans by default because free web
  services spin down after 15 minutes and a workspace gets only one free
  Postgres.
- **Connecting the apps Blueprint is manual,** once, because Render has no
  API for creating a Blueprint.
- **One factory per workspace.** Render rejects a second Blueprint that
  defines `vibe-factory-workflows`.
- **One apps repository and one branch per deployment.** When concurrent
  runs push at the same time, a run whose push is rejected takes the new tip
  and makes its change again.
- **Authentication is a demo convenience.** One Basic Auth user, one shared
  bearer token, and user slugs are not tenant isolation, authorization,
  quotas, or abuse controls.
- **Deletes are per app, not per run,** because the runs of an app share its
  files and resources. Deleted files stay in Git history.
- **The sandbox Postgres has no extensions.** It is a fresh Postgres 18, so
  an app that needs an extension passes verification only if it installs it.
- **A failed run is final.** There is no step-level resume, and Render
  Workflows does not retry `prompt-to-app`. Render reads are retried, up to
  five times in a row, but a transient error elsewhere, such as during the
  clone, ends the run. Submit the prompt again to start over.
- **No model reviewer.** The factory relies on deterministic checks and
  checks of the deployed app.
