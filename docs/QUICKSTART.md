# Quickstart

This guide takes you from a fresh clone to a deployed app, then to a factory
running on Render, and finally to customizing it. If you want to understand the
code first, read the [Walkthrough](WALKTHROUGH.md).

**Contents:**
[1. Prerequisites](#1-prerequisites) ·
[2. Local setup](#2-local-setup) ·
[3. First run](#3-first-run) ·
[4. Connect the apps Blueprint once](#4-connect-the-apps-blueprint-once) ·
[5. Deploy the factory to Render](#5-deploy-the-factory-to-render) ·
[6. Check the wiring](#6-check-the-wiring) ·
[7. Clean up](#7-clean-up) ·
[8. Extend and customize](#8-extend-and-customize) ·
[Configuration reference](#configuration-reference) ·
[Operations](#operations) ·
[Current limitations](#current-limitations)

> **Cost warning.** Local development changes only where the orchestration
> code runs. Every run, local or deployed, uses model tokens, creates a real
> Render Sandbox, and deploys real Render services that bill until you delete
> them. See [Clean up](#7-clean-up).

## 1. Prerequisites

You need all of these before the first run will succeed:

- **Node.js 22 or later.** `package.json` requires it.
- **Docker**, to run the local Postgres that holds run state
  (`docker-compose.yml`).
- **The Render CLI**, signed in with `render login`. `npm run dev:workflows`
  uses its local task server.
- **A Render workspace with Workflows and Sandboxes enabled.** You need:
  - a Render API key (Account Settings > API Keys), and
  - the workspace ID, which starts with `tea-`. Sandboxes are created in this
    workspace, and the factory looks for the apps Blueprint only here.
- **An Anthropic API key**, for the three agents.
- **An empty GitHub repository for generated apps** (the "apps repository").
  Render must be able to read it, so connect GitHub to your Render account
  and give Render access to this repository.
- **A credential that can push to the apps repository.** Pick one:
  - a fine-grained personal access token with Contents: write on that
    repository (fastest to set up), or
  - a GitHub App installed on that repository with Contents: write. Commits
    are attributed to the app, and its tokens expire hourly.

## 2. Local setup

Clone this repository, then install dependencies and create your `.env`:

```bash
npm ci
cp .env.example .env
```

Fill in `.env`. `.env.example` explains each value; the essentials are:

| Variable | What to put there |
| --- | --- |
| `APPS_REPO` | Your apps repository, as `owner/repo` |
| `RENDER_API_KEY` | Your Render API key |
| `RENDER_WORKSPACE_ID` | Your workspace ID (`tea-...`) |
| `ANTHROPIC_API_KEY` | Your Anthropic key |
| `GITHUB_TOKEN`, or the three `GITHUB_APP_*` values | Your push credential |
| `FACTORY_API_KEY` | At least 24 characters; generate one with `openssl rand -hex 32` |
| `UI_USERNAME` | A lowercase slug, 3 to 31 characters. It is also the folder your apps go in (`apps/<username>/`) and part of every resource name. |
| `UI_PASSWORD` | At least 16 characters |

Keep the defaults for `DATABASE_URL` and `RENDER_WORKFLOW_SLUG`. Do not add
`RENDER_USE_LOCAL_DEV` to `.env`: `npm run dev:gateway` sets it for the
gateway only, and the workflows host also reads `.env` but must use the real
Render API.

Now start the processes. `dev:postgres` stays in the foreground, so give it
its own terminal:

```bash
# Terminal 1: local Postgres on port 55432
npm run dev:postgres
```

```bash
# Terminal 2: apply app/schema.sql, then start the gateway on http://localhost:3000
npm run db:migrate
npm run dev:gateway
```

```bash
# Terminal 3: the workflows host, through the Render CLI's local task server
npm run dev:workflows
```

`dev:workflows` starts a local task server on port 8120 and registers every
task. The gateway sends tasks to that server instead of a deployed workflow
service. To list what registered:

```bash
render workflows tasks list --local
```

If `dev:workflows` is not running, a submission fails with `dispatch failed`.

## 3. First run

**From the UI.** Open `http://localhost:3000` and sign in with
`UI_USERNAME` and `UI_PASSWORD`. Type an idea and submit. The stage list shows
where the run is; hover over a stage to see what it does and where it runs.
**Table view** (`/table`) shows the same runs as tables, with stage timings and
links to the workflow run and the sandbox in the Render Dashboard. Local task
runs are not in the Dashboard, so local development shows no workflow links.

If an embedded browser, such as Cursor's preview, does not show the Basic Auth
prompt, set `UI_AUTH_DISABLED=true` for local preview. The gateway ignores it
when `NODE_ENV=production`.

**From a terminal.**

```bash
npm run demo -- "Create an online catalog for handcrafted furniture"
```

The script posts to `POST /v1/apps` with `FACTORY_API_KEY`, then polls the run
until it finishes and prints the URLs. It files apps under `FACTORY_USER`
(default `demo`). The UI lists only the runs of `UI_USERNAME`, so set both to
the same value if you want script runs to appear in the UI.

**What to pick.** A website, landing page, or menu gets one static site and
finishes fastest. Ask for data that users write and the app keeps, such as
"save the posts in a database", to get an API and Postgres too.

**What happens on the first run.** The run designs, builds, verifies, and
commits the app, then stops with status `awaiting_blueprint`. That is
expected: nothing on Render is watching the apps repository yet. The next step
fixes that once.

## 4. Connect the apps Blueprint once

Render has no API for creating a Blueprint, so this is the one manual step. You
do it once, not per app.

1. In the Render Dashboard, switch to the workspace that `RENDER_WORKSPACE_ID`
   names. The factory looks for the Blueprint only there.
2. Choose **New > Blueprint** and pick the apps repository.
3. Use branch `main` and Blueprint path `render.yaml` (the defaults in
   `factory.config.ts`).
4. Keep **Auto Sync** on. Without it, a push does not deploy.

If you change `branch` or `blueprintPath` in `factory.config.ts`, configure
the apps Blueprint with the same values.

Creating the Blueprint syncs the `render.yaml` that your first run committed,
so Render creates that app's resources. Submit a new idea to see a complete
run: it now waits for Render, smoke-tests the live URLs, and ends as
`deployed` with a link to the site.

Each app lands in its own Render project, named `vibe-<user>-<app>`, with
resources named `vibe-<user>-<app>-web`, `-api`, and `-db`.

## 5. Deploy the factory to Render

The factory's own `render.yaml` creates a `vibe-factory` project with:

- `vibe-factory-gateway`, a Docker web service on the starter plan, which runs
  `npm run db:migrate` before each deploy and uses `/ready` as its health check,
- `vibe-factory-workflows`, the workflow service that runs every task, and
- `vibe-factory-db`, the Postgres database both services use.

### If you deploy from a fork

The workflow service in `render.yaml` sets its source repository explicitly:

```yaml
repo: https://github.com/render-examples/vibe-code-demo
```

A workflow service in a Blueprint needs this field. If you leave it, Render
builds the workflow from the upstream repository, not your fork, and your code
changes never reach the workflows host. Change it to your fork's URL before you
create the Blueprint. If you use the Deploy to Render button, change the
`repo=` parameter in its link too.

### Create the Blueprint

1. Click **Deploy to Render** in the [README](../README.md), or choose
   **New > Blueprint** in the Dashboard and pick this repository (or your fork).
2. Fill in the variables the Dashboard prompts for. They are the same values as
   your `.env`; the [configuration reference](#configuration-reference) lists
   which service needs which. For GitHub, set the three `GITHUB_APP_*`
   variables or `GITHUB_TOKEN`. The Blueprint generates `FACTORY_API_KEY`,
   sets `DATABASE_URL` on both services, and points the gateway's
   `RENDER_WORKFLOW_SLUG` at the workflow service.
3. If you have not done it yet, [connect the apps Blueprint](#4-connect-the-apps-blueprint-once)
   in the workspace named by `RENDER_WORKSPACE_ID`.

Things to know:

- **Keep network isolation off** for the `production` environment. The
  workflow reaches the database over the private network, and an isolated
  environment blocks that. `render.yaml` sets `isolation: disabled`.
- **The workflow and database share a region** (`oregon` by default), for
  the same reason. Change both together.
- **One factory per workspace.** Render rejects a second Blueprint that
  defines `vibe-factory-workflows` in the same workspace.
- **Adopting a hand-made workflow service.** If you created the workflow
  service by hand before `render.yaml` defined it, rename it to
  `vibe-factory-workflows` before the next Blueprint sync. The Blueprint then
  adopts it and keeps its environment variables. Otherwise, the sync creates a
  second workflow without its secrets and points the gateway at it.

When the deploy finishes, open the gateway URL and sign in, or point the demo
script at it:

```bash
FACTORY_GATEWAY_URL=https://<your-gateway>.onrender.com npm run demo -- "Your idea"
```

## 6. Check the wiring

```bash
npm run doctor   # read-only; exits non-zero when a check fails
npm run check    # Biome lint, TypeScript, and the Vitest suite
```

`npm run doctor` reads the environment of the shell (and `.env` if present)
and checks, without changing anything:

- the configuration: each required variable, `APPS_REPO`'s format, and the
  strength of `FACTORY_API_KEY` and `UI_PASSWORD`,
- that the GitHub credential can read and push to the apps repository, and
  that its default branch is the one the factory pushes to,
- that a Blueprint in your workspace watches `main:render.yaml` of the apps
  repository, with Auto Sync on,
- that the Render MCP server is reachable and has every tool on the agents'
  read-only allowlist,
- that Postgres is reachable and the `runs` table has the expected columns,
- that all eleven workflow tasks register.

Each failure tells you how to fix it. Run it against your deployed services'
values before a demo.

### Before a live demo

Run `npm run doctor`, rehearse the prompt once, and delete that rehearsal app.
Keep a deployed fallback from a different prompt, sign in to the UI before
presenting, and confirm no other run is using one of the three concurrency
slots. After the event, delete every generated app you no longer need.

## 7. Clean up

Delete each generated app when you are done; apps with an API and database
leave paid resources running:

- in the UI, select one of its runs and click **Delete app**, or
- `curl -X DELETE -H "Authorization: Bearer $FACTORY_API_KEY" "$GATEWAY_URL/v1/apps/$RUN_ID"`

A delete takes the app out of the Blueprint, deletes its Render services,
database, and project, and removes its folder from the apps repository. It
takes a few minutes. Details and failure handling are in
[Delete failures](#delete-failures).

### Delete failures

A delete affects the app and all of its runs. The gateway refuses it with
`409` while any run of that app is active. During deletion, `progress` names
the current step; after success, `GET /v1/apps/:runId` returns `404`. Deleted
files remain in the apps repository's Git history.

If deletion ends as `delete_failed`, fix the cause and send the same request
again. Each step continues from the state left by the previous attempt. Two
failures require operator action:

- If an apps Blueprint sync did not finish within 6 minutes, let it finish or
  repair it in the Dashboard. Search the task logs for
  `blueprint_syncs_unfinished`.
- If the app's project contains a resource the factory did not create, delete
  or move it in the Dashboard. The `render_resource_kept` event identifies the
  resource.

The [delete flow](WALKTHROUGH.md#the-delete-flow) explains the four tasks and
why they run in that order.

To remove the factory itself, delete the `vibe-factory` project in the
Dashboard after you have deleted the generated apps. Deleting the factory
first leaves the generated apps running, with nothing left to delete them for
you.

## 8. Extend and customize

### Change the knobs in `factory.config.ts`

| Setting | Default | What it controls |
| --- | --- | --- |
| `branch` | `main` | The branch the factory pushes to. The apps Blueprint must track the same branch. |
| `blueprintPath` | `render.yaml` | The root Blueprint file in the apps repository. |
| `appsDir` | `apps` | The folder in the apps repository that holds `<user>/<app>/`. |
| `resourcePrefix` | `vibe` | The first part of every generated resource name. Each app stores its prefix in `factory.json`, so a change affects only new apps. |
| `render.region` | `oregon` | Region of generated web services and databases. |
| `render.servicePlan` | `starter` | Plan of generated web services. |
| `render.databasePlan` | `0.1c-256mb` | Plan of generated Postgres databases. |
| `render.postgresMajorVersion` | `18` | Postgres version of generated databases. |
| `assets.allowedHosts` | the two Wikimedia upload hosts | The only hosts image downloads may reach. |
| `assets.maxBytes` | 2 MB | Largest image the factory downloads. |
| `maxConcurrentRuns` | `3` | How many runs can build at once, across all users. |
| `models` | `claude-sonnet-5`, `claude-opus-5` | The model behind the `medium` and `large` tiers. Each agent in `app/agents.ts` picks a tier; all three use `medium`. |

A few limits live next to the code they bound: `maxTurns` for each agent in
`app/agents.ts`, `MAX_BUILD_ROUNDS` in `app/build.ts`, and
`MAX_DEPLOY_REPAIR_ROUNDS` and the deploy timeouts in `app/deploy.ts`.

### Add an agent

1. Define it in `app/agents.ts` with an `id`, a model tier, and a prompt. Grant
   sandbox `tools` only if it must work in the sandbox, and `renderTools`
   only from the read-only allowlist.
2. Register it with `agentTask()` at the bottom of that file.
3. Call it from the stage that needs it with `tasks.run(...)`.
4. If it returns JSON, give it a Zod schema in `app/contracts.ts`.
5. Add its task name to the tests and to `npm run doctor`.

The full checklist is in [AGENTS.md: Add an agent](../AGENTS.md#add-an-agent).
Add an agent only when a distinct context or a distinct set of permissions
helps; work that needs no judgment is better as plain workflow code.

### Add a Render primitive

The factory deploys only what it models: static sites, Node web services, and
Postgres. To add one, such as Key Value, you extend the whole path together:
the architect's choices and the manifest schema in `app/contracts.ts`, the
YAML in `app/blueprint.ts`, resource naming, verification in `app/verify.ts`,
and the delete in `app/teardown.ts`. Keeping that path closed is deliberate: the
factory never accepts free-form YAML from a model. Follow
[AGENTS.md: Add a Render primitive](../AGENTS.md#add-a-render-primitive).

### Change or add a template

`templates/fullstack` is the working Vite + React + Hono + Postgres app that
every run with an API starts from. It encodes the parts a model gets wrong
most often: CORS, the API URL in the storefront, and an idempotent migration
wired to `preDeployCommand`. When you change it, keep it building (CI builds
both halves), keep the seed non-empty, and update `templateLines()` in
`app/build.ts`, which tells the builder the manifest the template implies.

To add a second template, add a folder under `templates/`, decide in `run()`
in `app/workflow.ts` when to use it (today the choice is "the plan has a
`web_service`"), give the builder the matching instructions, and add it to the
`templates` job in `.github/workflows/ci.yml`. See
[AGENTS.md: Change a template](../AGENTS.md#change-a-template).

### Where to extend the factory

- **Primitives:** extend the manifest, the Blueprint generator, verification,
  and teardown together, as above.
- **Agent roles:** grant tools explicitly, and keep `tests/agents.test.ts` as
  the executable access review.
- **External assets:** treat a new source as a change to what the workflow
  may download, not only a search integration. Put the host, content type,
  size, and destination checks in workflow code, as `app/images.ts` does.
- **Review:** this demo relies on deterministic checks and checks of the
  deployed app, not a model reviewer. For higher-risk generation, add a review
  step before publishing, at the cost of time and tokens.
- **Users and tenancy:** the gateway has one Basic Auth user and one shared
  bearer token. A real product needs its own authentication, per-tenant
  quotas, and abuse controls in front of `createRun()` in `app/gateway.ts`.

Before you change trust boundaries, read the
[invariants in AGENTS.md](../AGENTS.md#invariants). They are the canonical list
of safety rules.

## Configuration reference

This section lists environment variables. [`.env.example`](../.env.example)
contains the same variables with comments.

| Variable | Read by | Purpose |
| --- | --- | --- |
| `APPS_REPO` | Workflows | The repository generated apps are committed to, as `owner/repo`. The factory Blueprint also collects the same value on the gateway service for consistent Dashboard configuration, although the gateway process does not read it. |
| `DATABASE_URL` | Both | Postgres connection string for the `runs` table |
| `RENDER_API_KEY` | Both | The gateway starts tasks with it. The workflows host uses it for Sandboxes, read-only platform inspection, deploy and Blueprint reads, logs, and resource deletion. |
| `FACTORY_API_KEY` | Gateway | Bearer token for `/v1/*`, at least 24 characters. The Blueprint generates it. |
| `UI_USERNAME` | Gateway | UI login and namespace for apps submitted in the UI; a lowercase slug |
| `UI_PASSWORD` | Gateway | UI password, at least 16 characters |
| `UI_AUTH_DISABLED` | Gateway | `true` skips Basic Auth for local preview; ignored when `NODE_ENV=production` |
| `RENDER_WORKFLOW_SLUG` | Gateway | Workflow service slug, without a task name. The Blueprint sets it. |
| `PORT` | Gateway | HTTP port; defaults to `3000` |
| `RENDER_WORKSPACE_ID` | Workflows | Workspace (`tea-...`) for Sandboxes, services, and the apps Blueprint |
| `ANTHROPIC_API_KEY` | Workflows | Claude Agent SDK credential |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID` | Workflows | Preferred GitHub App credentials. The private key may be PEM, PEM with escaped newlines, or base64. |
| `GITHUB_TOKEN` | Workflows | Fine-grained personal access token, used when no GitHub App is configured |
| `RENDER_MCP_URL` | Workflows | Optional Render MCP endpoint; defaults to `https://mcp.render.com/mcp` |
| `GITHUB_API_URL` | Workflows | Optional GitHub API base URL; defaults to `https://api.github.com` |
| `FACTORY_GATEWAY_URL`, `FACTORY_USER` | `npm run demo` | Gateway to call and namespace for script-submitted apps |

`npm run dev:gateway` sets `RENDER_USE_LOCAL_DEV=true` for the gateway so it
uses the local workflow task server. Do not put this variable in `.env`: the
workflows host reads that file too and must use the real Render API.

The remaining settings live in `factory.config.ts`; see
[Change the knobs](#change-the-knobs-in-factoryconfigts).

## Operations

The [HTTP API and run statuses](WALKTHROUGH.md#http-api-and-run-statuses)
section defines the status payload. For a stuck run, start with
`GET /v1/apps/:runId` and the service's task runs in the Render Dashboard.

### Long-running stages

- **`verifying`:** `verify-app` builds, boots, and queries the app in a
  Sandbox. A build command that never exits hits the 30-minute deadline and
  the run ends as `failed`.
- **`waiting_for_services`:** Blueprint sync has not created every expected
  service. The run ends as `deploy_failed` after 6 minutes; Auto Sync being
  off is the usual cause.
- **`waiting_for_deploys`:** the workflow is waiting for a deploy newer than
  the push it just made. If no new deploy starts within 15 minutes, the run
  ends as `deploy_failed`.
- **`smoke_testing`:** the workflow checks the public URLs, storefront API
  hostname, data, and CORS. New hostnames can return 404 for several minutes;
  site and API-health checks wait up to 10 minutes and the data check up to
  3 minutes.

Every wait updates `progress`. Render API reads retry after 5 seconds and fail
after five consecutive errors; a 401 or 403 fails immediately. When a task
crashes, times out, or is canceled before recording a result, the next status
read reconciles the task run and frees its concurrency slot.

### Log events

Workflow code writes one JSON line per notable event. Search task logs for the
`event` field:

| Task | Events |
| --- | --- |
| `prompt-to-app` | `image_skipped`, `model_json_repair`, `render_read_failed`, `deploy_logs_unavailable` |
| Agents | `agent_completed`, with model and token counts |
| `verify-app` | `app_verified`; `app_verification_failed` |
| `publish-app` | `app_published`; `skipped_app_spec` |
| `remove-app-from-blueprint` | `app_removed_from_blueprint`; `app_spec_not_found` |
| `wait-for-blueprint-syncs` | `push_event_wait`; `blueprint_syncs_unfinished`; `blueprint_syncs_finished`; `blueprint_not_found`; `render_read_failed` |
| `delete-app-resources` | `render_resource_deleted`; `render_resource_kept`; `render_project_not_empty`; `render_project_deleted`; `render_project_not_found` |
| `remove-app-files` | `app_files_removed` |
| `delete-app` | `app_deleted`; `app_delete_failed` |

## Current limitations

- **Every run costs money, including local development.** It uses model
  tokens and a Render Sandbox, then deploys services.
- **Generated apps run until you delete them.** APIs and databases use paid
  plans because free web services spin down and a workspace gets only one free
  Postgres.
- **Connecting the apps Blueprint is manual once.** Render has no API for
  creating a Blueprint.
- **One factory can run in a workspace.** Render rejects another Blueprint
  that defines `vibe-factory-workflows`.
- **Each deployment uses one apps repository and branch.** Concurrent pushes
  that lose the race retry on the new branch tip.
- **Authentication is for a trusted demo.** One Basic Auth user, one bearer
  token, and user slugs do not provide tenant isolation, authorization,
  quotas, or abuse controls.
- **Deletion is per app, not per run.** An app's runs share files and
  resources, and deleted files remain in Git history.
- **Sandbox Postgres has no extensions.** It is a fresh Postgres 18; an app
  requiring an extension must install it during verification.
- **Failed runs do not resume from a step.** `prompt-to-app` is not retried;
  submit the prompt again. Render reads have their own bounded retries.
- **There is no model reviewer.** Deterministic checks and live smoke tests
  decide whether an app passes.

### Cost guide

These October 2026 estimates are for planning only; verify
[Render pricing](https://render.com/pricing) and
[Anthropic pricing](https://www.anthropic.com/pricing) before quoting them.

- Model usage is roughly $1–$5 per run with the default agents.
- The gateway and factory Postgres are roughly $7 per month each.
- A generated app with an API and database is roughly $14 per month until
  deleted; a static-only app uses a free static site.
