# Quickstart

Deploy the factory, create an app, verify it, and clean it up. Once the
default path works, use [1_EXTENSION.md](1_EXTENSION.md) to customize the
factory. To understand the implementation, continue to
[2_ARCHITECTURE.md](2_ARCHITECTURE.md).

> **Cost warning.** Local development changes only where the orchestration
> code runs. Every app run still uses model tokens, creates a real Render
> Sandbox, and deploys real Render resources. Those resources continue to
> bill until you delete the app.

## Prerequisites

You need:

- Node.js 22 or later and Docker.
- The [Render CLI](https://render.com/docs/cli), signed in with
  `render login`.
- A Render workspace with Workflows and
  [Sandboxes early access](https://render.com/docs/sandboxes) enabled.
- A Render API key and that workspace's ID (`tea-...`).
- An Anthropic API key.
- An empty GitHub repository for generated apps (the **apps repository**).
- The [Render GitHub app](https://github.com/apps/render) installed on the
  apps repository, so Render can read it for Blueprint sync. This is not the
  push credential below.
- A credential that can push to the apps repository:
  - a fine-grained personal access token with Contents: write, or
  - a GitHub App installed on the repository with Contents: write.

Local development uses a local Postgres for run state, but Sandboxes and
generated apps still run on Render.

## Run the factory locally

### 1. Install and configure

```bash
npm ci
cp .env.example .env
```

Set the following values in `.env`:

- `APPS_REPO`: the apps repository as `owner/repo`.
- `RENDER_API_KEY`: a key for the target Render workspace.
- `RENDER_WORKSPACE_ID`: the workspace ID.
- `ANTHROPIC_API_KEY`: the model credential.
- Either `GITHUB_TOKEN` or all three `GITHUB_APP_*` values.
- `FACTORY_API_KEY`: at least 24 characters. Generate one with
  `openssl rand -hex 32`.
- `UI_USERNAME`: a lowercase slug, 3–31 characters. It becomes the
  `apps/<user>/` namespace and part of generated resource names.
- `UI_PASSWORD`: at least 16 characters.

Keep the default `DATABASE_URL` and `RENDER_WORKFLOW_SLUG` values for local
development.

Do not put `RENDER_USE_LOCAL_DEV` in `.env`. The gateway must use the local
task server, while the workflows host must use the real Render API.

### 2. Start the three local processes

Use one terminal per process:

```bash
# Terminal 1: run-state database
npm run dev:postgres
```

```bash
# Terminal 2: schema and gateway
npm run db:migrate
npm run dev:gateway
```

```bash
# Terminal 3: local Workflows task server
npm run dev:workflows
```

The gateway is available at `http://localhost:3000`. Confirm all tasks
registered:

```bash
render workflows tasks list --local
```

If the workflow host is not running, submissions fail with
`dispatch failed`.

### 3. Connect the apps Blueprint

This is a one-time step. Render deploys generated apps from a Blueprint that
watches the apps repository's root `render.yaml`, and Render does not expose
an API for creating a Blueprint.

First commit an empty root Blueprint to the apps repository:

```bash
npm run setup:apps-repo
```

The script does nothing if the file already exists. Then, in the Render
Dashboard:

1. Open the workspace identified by `RENDER_WORKSPACE_ID`.
2. Choose **New > Blueprint** and select the apps repository.
3. Use branch `main` and Blueprint path `render.yaml`.
4. Keep **Auto Sync** enabled.

These values must match `branch` and `blueprintPath` in
[`factory.config.ts`](../factory.config.ts). `npm run doctor` confirms the
Blueprint is watching with Auto Sync on.

If you skip this step, runs still commit their apps but end as
`awaiting_blueprint`. Connecting the Blueprint later deploys everything
already committed.

### 4. Create the first app

Open `http://localhost:3000`, sign in with `UI_USERNAME` and `UI_PASSWORD`,
and submit an idea. The stage table shows how long each stage takes, where it
runs, and links to the matching Render Dashboard pages.

An embedded preview that cannot show a Basic Auth prompt may use
`UI_AUTH_DISABLED=true` locally. The gateway ignores that setting in
production.

You can also use the demo client:

```bash
npm run demo -- "Create an online catalog for handcrafted furniture"
```

The demo client uses `FACTORY_USER` (default `demo`). The UI lists only the
`UI_USERNAME` namespace, so set those values to the same slug when you want
CLI-created runs to appear in the UI.

A brochure or landing-page prompt usually produces one static site. A prompt
that explicitly requires persistent user-written data produces a site, API,
and Postgres database.

A successful run finishes as `deployed` only after the workflow smoke-tests
the public site and, when present, its API.

Each app gets its own Render project. The app name is the architect's slug
plus the first four characters of the run ID, so two similar prompts never
overwrite each other's app:

```text
vibe-<user>-<app>-<run>
├── vibe-<user>-<app>-<run>-web
├── vibe-<user>-<app>-<run>-api     # when needed
└── vibe-<user>-<app>-<run>-db      # when needed
```

Generated static sites are free. An API uses the `0.5c-512mb` plan and a
database the `0.1c-256mb` plan from
[`factory.config.ts`](../factory.config.ts), and both bill until you delete
the app.

## Deploy the factory to Render

The factory's [`render.yaml`](../render.yaml) creates:

- `vibe-factory-gateway`, a Docker web service;
- `vibe-factory-workflows`, the Workflows host; and
- `vibe-factory-db`, the Postgres database shared by both.

Create a Blueprint from this repository or use the Deploy to Render button in
the [README](../README.md). Fill in the prompted values listed under
[Prerequisites](#prerequisites). `UI_PASSWORD` must contain at least 16
characters or the gateway will refuse to start.

The secrets live in two environment groups, so you enter each one once:

- `vibe-factory-shared` holds `RENDER_API_KEY` and is attached to both
  services.
- `vibe-factory-workflow-secrets` holds `APPS_REPO`, `RENDER_WORKSPACE_ID`,
  `ANTHROPIC_API_KEY`, and the GitHub credential, and is attached only to the
  workflow service.

To rotate a key, change it in its group. Both services build from the
repository that holds the Blueprint, so a fork runs its own code.

Keep these deployment constraints:

- The workflow service and database must use the same region.
- Network isolation must remain disabled for the factory environment so
  workflow tasks can reach Postgres over the private network.
- Only one factory using the default workflow service name can exist in a
  workspace.
- The apps Blueprint must exist in the workspace identified by
  `RENDER_WORKSPACE_ID`. If you have not connected it yet, follow
  [Connect the apps Blueprint](#3-connect-the-apps-blueprint).
  `npm run setup:apps-repo` needs only `APPS_REPO` and a GitHub credential in
  your local `.env`.

After deployment, open the gateway URL or point the demo client at it:

```bash
FACTORY_GATEWAY_URL=https://<gateway>.onrender.com \
  npm run demo -- "Build a website for a neighborhood bakery"
```

## Verify the wiring

First run the code checks:

```bash
npm run check
```

To run the doctor against a factory deployed with the Deploy to Render button,
create a local `.env` from the deployed resources:

1. Copy `.env.example` to `.env`.
2. From `vibe-factory-gateway`, copy `FACTORY_API_KEY`, `UI_USERNAME`,
   `UI_PASSWORD`, and `RENDER_WORKFLOW_SLUG`.
3. From the `vibe-factory-shared` environment group, copy `RENDER_API_KEY`.
   From `vibe-factory-workflow-secrets`, copy `APPS_REPO`,
   `RENDER_WORKSPACE_ID`, `ANTHROPIC_API_KEY`, and either `GITHUB_TOKEN` or
   the three `GITHUB_APP_*` values.
4. Open `vibe-factory-db` in the Dashboard and copy its **external**
   connection URL. Set that as `DATABASE_URL` and append
   `?sslmode=require` (or `&sslmode=require` when the URL already has a
   query). The internal URL is not reachable from your laptop.

Then run:

```bash
npm run doctor
```

Keep this `.env` private; it contains production credentials.

`npm run doctor` is read-only. It checks:

- required configuration and credential shape;
- that the configured Anthropic model IDs are available;
- GitHub read and push access and the default branch;
- the apps Blueprint's repository, path, branch, and Auto Sync setting;
- the Render MCP server and the agents' read-only tool allowlist;
- Postgres and the `runs` schema; and
- registration of all workflow tasks.

`npm run check` runs Biome, TypeScript, and Vitest.

Before a live demo, run the doctor, rehearse the prompt once, delete the
rehearsal app, and keep a separate deployed fallback.

## Observe and troubleshoot runs

Start with `GET /v1/apps/:runId`, the UI's stage history, and the workflow
task in the Render Dashboard.

The common long-running stages are:

- `verifying`: the workflow is building, booting, and querying the app in the
  Sandbox.
- `waiting_for_services`: the apps Blueprint has not created every expected
  service. Auto Sync being disabled is the usual cause.
- `waiting_for_deploys`: the workflow is waiting for a deploy newer than the
  commit it just pushed.
- `smoke_testing`: public DNS and routing may still be converging, or the
  workflow is checking the storefront, data endpoint, and CORS.

Useful structured log events include:

- `agent_completed`
- `app_verified` and `app_verification_failed`
- `app_published`
- `render_read_failed`
- `deploy_logs_unavailable`
- `blueprint_syncs_unfinished`
- `app_deleted` and `app_delete_failed`

The architecture guide documents the complete
[request path](2_ARCHITECTURE.md#prompt-to-live-app) and
[delete path](2_ARCHITECTURE.md#delete-an-app).

## Delete generated apps

Delete every generated app when you are done. Apps with an API and database
leave paid resources running.

Use the UI's **Delete app** action or:

```bash
curl -X DELETE \
  -H "Authorization: Bearer $FACTORY_API_KEY" \
  "$FACTORY_GATEWAY_URL/v1/apps/$RUN_ID"
```

Deletion removes the app from the root Blueprint, waits for older Blueprint
syncs, deletes the app's Render resources and project, and finally removes its
directory from the apps repository. Deleted files remain in Git history.

If deletion ends as `delete_failed`, fix the reported condition and send the
same request again. The delete steps are intentionally restartable.

Delete generated apps before deleting the `vibe-factory` project. Removing
the factory first leaves the apps running without the workflow that cleans
them up.

## Current limitations

- Every run incurs model and Sandbox usage, including local development.
- Generated APIs and databases continue to bill until the app is deleted.
- Connecting the apps Blueprint is a one-time manual step.
- Authentication is suitable for a trusted demo, not a multi-tenant product:
  one Basic Auth user and one shared bearer token provide no tenant
  isolation, per-user quotas, or abuse controls.
- Failed top-level runs do not resume from a checkpoint. Submit the prompt
  again.
- Deletion is per app, not per run, because all runs of an app share files
  and resources.
- The factory supports only the primitives modeled in its contracts:
  static sites, Node web services, and Postgres.
- Deterministic verification and live smoke tests decide success; there is no
  model reviewer.

See [1_EXTENSION.md](1_EXTENSION.md) before changing these boundaries and
[3_TAKEAWAYS.md](3_TAKEAWAYS.md) for the patterns worth reusing elsewhere.
