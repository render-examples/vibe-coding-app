# Walkthrough

Follow one run through the codebase, file by file. Start with the two
processes and HTTP interface, then trace a request to a live app. The later
sections cover the main types, trust boundaries, deletion, state, and tests.

Keep the code open beside this page. Everything that matters is under `app/`,
one concern per file, and `app/workflow.ts` reads as the table of contents.

**Contents:**
[Two processes](#two-processes) ·
[HTTP API and run statuses](#http-api-and-run-statuses) ·
[Repository layout](#repository-layout) ·
[One run, end to end](#one-run-end-to-end) ·
[Key interfaces](#key-interfaces-and-types) ·
[Trust boundaries](#trust-boundaries-in-the-code) ·
[The delete flow](#the-delete-flow) ·
[State and reconciliation](#state-and-reconciliation) ·
[Tests](#how-the-tests-are-organized)

## Two processes

The factory is two programs that deploy separately and share one Postgres
database.

**The gateway** (`app/server.ts`, with the routes in `app/gateway.ts`) is a
Hono web service. It listens on `0.0.0.0:$PORT`, authenticates callers,
validates input, records each run in Postgres, starts a workflow task, and
answers status requests. It also serves the browser UI from `public/`.

**The workflows host** (`app/host.ts`) registers every Render Workflows task
and waits for work. Render runs each task on its own compute. This is where
models are called, sandboxes are created, code is pushed to GitHub, and
deploys are watched.

They are separate because they hold different secrets and face different
risks. Each process checks its own environment at startup, in
`assertGatewayEnv()` and `assertWorkflowEnv()` in `app/config.ts`:

| | Gateway | Workflows host |
| --- | --- | --- |
| Faces the internet | Yes | No |
| `ANTHROPIC_API_KEY` | No | Yes |
| GitHub credential | No | Yes |
| `RENDER_API_KEY` | Yes, to start tasks | Yes |
| `DATABASE_URL` | Yes | Yes |

A bug in the public-facing process cannot leak the model key or push to
GitHub, because that process never has them. The cost is operating two
services instead of one.

`app/host.ts` has one subtlety worth knowing. The Render SDK starts its task
server on the event-loop turn after the first `task()` call, so every task
must register in the same synchronous pass. The host does this with a single
`await import("./workflow.js")`, which pulls in every task module at once. A
task defined in a second import, or a top-level `await` in a task module, can
miss registration. `tests/host.test.ts` checks this in a real Node process.

## HTTP API and run statuses

The gateway exposes health checks, a bearer-authenticated API, and
Basic-Auth browser routes:

| Route | Auth | What it does |
| --- | --- | --- |
| `GET /health` | None | Liveness |
| `GET /ready` | None | Checks Postgres; the Render health check |
| `POST /v1/apps` | Bearer | Starts a run |
| `GET /v1/apps/:runId` | Bearer | Reads a run |
| `DELETE /v1/apps/:runId` | Bearer | Deletes the run's app and all of its runs |
| `GET`, `POST /ui/apps`; `GET`, `DELETE /ui/apps/:runId` | Basic | Browser equivalents scoped to `UI_USERNAME` |
| `GET /`, `GET /table` | Basic | The two browser views |

`POST /v1/apps` accepts `prompt` (8–2,000 characters), optional `user`
(a lowercase slug, default `demo`), and optional `idempotencyKey`. Reusing a
key returns the original run with `duplicate: true`. A new run returns `202`
with `runId` and `statusUrl`; the gateway returns `429` at the concurrency
cap, `413` above 64 KB, `400` for invalid input, and `502` when task dispatch
fails.

`GET /v1/apps/:runId` returns `status`, `stage`, `progress`, `stageHistory`,
`appName`, `urls`, `blueprintPath`, `summary`, timestamps, and Dashboard
links. Secret-shaped strings are redacted from summaries and progress.

| Status | Meaning |
| --- | --- |
| `running` | `prompt-to-app` is working; `stage` and `progress` say where |
| `deployed` | The app is live and passed smoke checks |
| `awaiting_blueprint` | The app is committed, but no Blueprint watches the apps repository |
| `build_failed` | Verification still failed after the builder's repair rounds |
| `deploy_failed` | Render could not deploy the app, or a live smoke check failed |
| `failed` | The run stopped for another reason; `summary` says why |
| `deleting`, `delete_failed` | Deletion is in progress or failed |

The Quickstart's [Operations](QUICKSTART.md#operations) section explains
long-running stages, log events, and operator recovery.

## Repository layout

```text
factory.config.ts   The knobs: branch, plans, region, asset hosts, cap, models
render.yaml         The factory's own Blueprint (gateway, workflow, database)
app/                All application code, one concern per file
public/             The browser UI: index.html + app.js, table.html + table.js, runs.js
templates/fullstack The Vite + React + Hono + Postgres starting point
scripts/            migrate, doctor, demo
tests/              One Vitest file per module, plus host and workflow suites
```

The files in `app/` fall into a few groups:

- **Entrypoints:** `server.ts` (gateway) and `host.ts` (workflows).
- **The pipeline:** `workflow.ts` holds the two task narratives,
  `prompt-to-app` and `delete-app`. Each stage's detail is in its own module:
  `build.ts`, `verify.ts`, `publish.ts`, `deploy.ts`, and `delete.ts`.
- **Agents:** `agents.ts` (the three agents and `agentTask()`), `claude.ts`
  (`runClaude()` over the Claude Agent SDK), `tools.ts` (sandbox tools), and
  `policy.ts` (the rules every tool call is checked against).
- **Talking to the outside:** `sandbox.ts` (Render Sandboxes), `blueprint.ts`
  (YAML generation), `render.ts` (REST reads of Render), `teardown.ts` (the
  only Render write calls, which are deletes), `git.ts` (clone, commit,
  push), `files.ts` (copying an app's files between sandboxes as data),
  `github.ts` (GitHub credentials), and `images.ts` (Wikimedia Commons).
- **State and contracts:** `store.ts` and `schema.sql` (the `runs` table),
  `contracts.ts` (Zod schemas), and `config.ts` (environment parsing).
- **Content:** `templates.ts` writes a template into the sandbox.

[AGENTS.md](../AGENTS.md#repository-map) has a one-line description of each
file and the allowed import directions.

## One run, end to end

### 1. The request reaches the gateway

A run starts at `POST /v1/apps` or `POST /ui/apps`, described in
[HTTP API and run statuses](#http-api-and-run-statuses). Both call
`createRun()` in `app/gateway.ts`. Before the handler runs, Hono's
`bodyLimit` rejects bodies over 64 KB, and `bearerAuth` or `basicAuth` checks
the caller.

`createRun()` parses the body with `createAppRequestSchema` from
`app/contracts.ts`. For a UI request, it replaces `user` with the signed-in
`UI_USERNAME`, so a browser cannot file apps under someone else's namespace.
It then generates a `runId` and calls `claimRun()` in `app/store.ts`.

`claimRun()` enforces two limits in Postgres:

- **Idempotency.** `runs.idempotency_key` is unique. If the caller sent a key
  that was already used, the insert does nothing, and the gateway returns the
  existing run with `duplicate: true`. Without a key, the run ID is the key.
- **The concurrency cap.** The insert is conditional on fewer than
  `maxConcurrentRuns` rows being `running`. Two gateway requests could both
  count the same rows and both insert, so the count and insert run inside a
  transaction that first takes a transaction-scoped Postgres advisory lock.
  That serializes claims, and the lock is released when the transaction ends.
  When the cap is reached, the gateway returns `429`.

With the row claimed, `dispatchWorkflow()` starts the `prompt-to-app` task
through the Render SDK with only `{ prompt, user, runId }`, and stores the
returned task-run ID with `setWorkflowRunId()`. The caller gets `202` and a
`statusUrl` to poll.

### 2. The task starts: `promptToApp`

`promptToApp` in `app/workflow.ts` is the `prompt-to-app` task. It validates
its input with `workflowInputSchema`, calls `run()`, and records the outcome
with `finishRun()`. If `run()` throws, the catch block records `failed` with
the error message before rethrowing.

The task sets `retry: { maxRetries: 0 }`. Render Workflows retries a failed
task three times by default, but a retry here would start over at the
architect with a new sandbox, after the row was already marked `failed`. A
caller who wants another attempt posts the prompt again.

`run()` is the whole pipeline in about a hundred lines. Each stage calls
`setRunStage()`, which updates `stage` and appends to `stage_history` so the
UI can show timings.

### 3. Design: the architect

```ts
const plan = await agentJson(
  (message) => tasks.run(architectTask, { message }),
  deployPlanSchema,
  `Product prompt:\n${prompt}`,
  "architect",
);
```

`tasks.run()` starts the `architect` agent as a subtask. `agentJson()` in
`app/claude.ts` validates the result against the `DeployPlan` Zod schema. If
it does not match, it sends the agent the validation error once, and fails the
stage if the second answer is also invalid.

The architect has no sandbox, only the read-only Render MCP tools, which it
can use to see what already exists in the workspace. It returns an app name
(a slug), the Render primitives it chose (`static_site`, `web_service`,
`postgres`) with a reason for each, up to four photo subjects, and a brief:
pages, features, voice, content, and the data model with seed rows.

Next, `claimRunApp()` records the app name on the run. It takes a per-app
Postgres advisory lock, and refuses if a delete of the same app is in
progress or another run is building it. Those refusals are returned as a
`failed` result with an explanation, not thrown, because they are expected
outcomes rather than faults.

### 4. A sandbox that holds only this app

```ts
const sandbox = await createSandbox({ timeoutSeconds: SANDBOX_TIMEOUT_SECONDS });
try {
  await recordSandbox(runId, sandbox);
  const appDir = appPath(user, appName);
  await initAppDir(sandbox, appDir);
  // ...every remaining stage...
} finally {
  await sandbox.terminate();
}
```

`createSandbox()` in `app/sandbox.ts` creates a Render Sandbox in the
configured workspace and waits until it is running. `recordSandbox()` saves
its ID for the Dashboard link in the UI.

`initAppDir()` in `app/git.ts` runs `git init` at `factoryConfig.repoDir` and
creates the app directory, `/home/user/repo/apps/<user>/<app>`. That
repository has no remote, and nothing in this sandbox ever gets a GitHub
token. Git is there only so later steps can ask which files a commit of the
app would contain. Every path an agent uses is resolved against `appDir`.

The `finally` block terminates the sandbox however the run ends.

### 5. Database, template, and photographs

Three pieces of workflow code prepare the sandbox before the builder starts:

- **Postgres.** If the plan includes `postgres`, `ensureSandboxPostgres()`
  installs and starts a real Postgres inside the sandbox and returns its URL.
  The builder develops against it, and verification migrates and queries it.
- **Template.** If the plan includes a `web_service`, `materializeTemplate()`
  in `app/templates.ts` writes `templates/fullstack` into the app directory
  with one self-extracting shell script. The template already has CORS, the
  API URL wiring, and an idempotent migration, so the builder starts from a
  working three-tier app.
- **Photographs.** `collectImages()` in `app/images.ts` searches Wikimedia
  Commons for each subject, picks a wide, high-resolution candidate with
  `bestCandidate()`, and downloads it with `downloadImage()`. The download
  follows redirects itself, at most three, and checks every URL with
  `allowedUrl()`: HTTPS only, and only the hosts in
  `factoryConfig.assets.allowedHosts`. `imageBody()` then accepts only an
  `image/*` response, refuses a declared length over the size cap, and stops
  reading once the body passes the cap. Each file is saved under `assets/` with a name the
  code makes from the subject. A subject that fails is logged as
  `image_skipped` and left out; it never fails the run.

No model chooses a URL or a file name here. Finding photos needs no judgment,
so it is plain code.

### 6. Build and verify

`buildAndVerify()` in `app/build.ts` alternates between the builder agent and
the `verify-app` task:

1. `runBuilder()` starts the `builder` agent with the `sandboxId` and
   `workDir`, and validates its answer with `buildOutputSchema`: a short
   summary and a **manifest** describing each service it built.
2. `verify-app` checks the result in the same sandbox. It returns a list of
   failures, or an empty list.
3. If there are failures, the builder gets them verbatim and tries again, up
   to `MAX_BUILD_ROUNDS` (2) repair rounds. After that the run ends as
   `build_failed`.

The builder's first message comes from `builderMessage()`, which includes the
plan, the template's expected manifest from `templateLines()`, the sandbox
database URL, and one line per photograph with its credit.

`verify()` in `app/verify.ts` is the heart of pre-deploy checking. It starts
from exactly the files a commit would hold:

1. Fail at once if the app directory is empty.
2. Write the `.gitignore` from `appGitignore(manifest)`, which ignores
   `node_modules/` and each static site's publish directory, then call
   `removeIgnored()` to delete every ignored file. Render builds from a fresh
   clone, so a build that depends on an ignored file fails here instead.
3. For each service in the manifest:
   - `checkStaticSiteEnvVars()` rejects a static site that takes a
     private-network address (`host`, `port`, `hostport`) from another
     service, since a browser cannot reach it.
   - Run the `buildCommand` with `runVerification()`.
   - For a static site, require `index.html` of at least 200 bytes in the
     publish directory, and no placeholder text such as "lorem ipsum".
   - For a web service with a `healthCheckPath`, boot it with an
     unreachable `DATABASE_URL`, to prove the health endpoint answers before
     the database is up, as Render's health check requires. If the app has a
     database and the service a `dataCheckPath`, run `preDeployCommand`
     against the sandbox Postgres, boot the service again, and require
     `dataCheckPath` to return non-empty data.
4. Finally, read the files with `readAppFiles()` exactly as `publish-app`
   will, so the builder can fix anything publishing would refuse, such as a
   symbolic link.

### 7. Publish from a clean sandbox

After verification passes, `run()` builds the `AppSpec` that becomes
`factory.json`: the user, app name, prompt, summary, creation time,
`resourcePrefix`, and the manifest.

Just before the push, `run()` calls `deploysBeforePublish()` in
`app/deploy.ts`. It uses `latestDeploys()` in `app/render.ts` to record the
newest deploy of each of the app's services that already exist on Render. For
a new app nothing exists yet and the map is empty; for a rerun that chose an
existing app name, step 8 needs it to tell the new deploy from the old one.

`publishAppTask` in `app/publish.ts` then does the push:

1. `readAppFiles()` in `app/files.ts` packs the files a commit of the app
   would hold into a tar in the build sandbox, downloads it, and accepts only
   regular files with plain relative paths, up to `MAX_APP_BYTES` (50 MB). The
   builder could run anything in that sandbox, so its files are treated as
   untrusted data.
2. `inAppsClone()` creates a **second** sandbox that no agent has touched,
   fetches a token with `githubToken()` from `app/github.ts`, and clones the
   apps repository with `cloneAppsRepo()`. The clone sets
   `core.symlinks=false`, so a symbolic link committed earlier becomes a plain
   file that no later write can follow.
3. `commitAndPush()` writes the files with `writeAppFiles()`, writes
   `factory.json`, the app's own `render.yaml` (`appBlueprint()`), and its
   README, and regenerates the root `render.yaml` with `writeRootBlueprint()`.
   That function reads every app's `factory.json` and calls `rootBlueprint()`.
4. `commitPaths()` stages only `apps/<user>/<app>/` and the root
   `render.yaml`.
5. `pushVerified()` refuses a commit that touches any other path, pushes, and
   checks with `git ls-remote` that the remote branch now points at this
   commit. If another run pushed first, it fetches the new tip and makes the
   change again. The root Blueprint is derived from the `factory.json` files,
   never merged, so redoing the change on a new tip is always correct.

The task returns a `PublishResult`: the pushed `commit` (or `null` if nothing
changed, which ends the run as `build_failed`) and `changedServices`.
`servicesChangedBy()` computes that list from `headChangedPaths()`: a service
changed if the commit touches a path in its directory. That is the same rule
as each service's `buildFilter` in the Blueprint, so these are exactly the
services Render will deploy again.

From here, Render takes over. The apps Blueprint sees the push and syncs. No
agent and no API call created anything.

### 8. Wait for Render, repair, and smoke-test

`awaitDeployment()` in `app/deploy.ts` runs the rest, one helper per phase:

1. **Find the Blueprint.** `findBlueprint()` in `app/render.ts` looks for a
   Blueprint in the workspace that watches the apps repository's branch and
   path. If none exists, `awaitingBlueprint()` ends the run as
   `awaiting_blueprint`.
2. **Wait for services.** `waitForAppServices()` calls `waitForServices()`,
   which polls until every expected resource name exists, for up to 6
   minutes, then saves their public URLs with `setRunUrls()`.
3. **Wait for deploys.** `deployWithRepairs()` runs the deploy loop. Each
   round, `waitForDeploys()` calls `waitForDeploy()` for each service, which
   polls its newest deploy until it is `live` or failed, for up to 15
   minutes. Its `after` option names a deploy to ignore, so the result must be
   a newer deploy. `firstWaits()` sets up the first round: a service that
   existed before the push and that the commit changed waits for a deploy newer
   than the one `deploysBeforePublish()` recorded, so a rebuild does not
   mistake the old live deploy for the new one. Every other service takes its
   newest deploy as its result, because Render does not redeploy a service
   whose files did not change.
4. **Repair a failed deploy** in `repairDeploys()`, up to
   `MAX_DEPLOY_REPAIR_ROUNDS` (2) times:
   - `failedDeployReport()` fetches the logs of each failed deploy with
     `fetchDeployLogs()`, redacts them with `redactSecrets()`, and keeps the
     last 4,000 characters. Redaction comes before the cut, so a secret is
     never split in a way the redactor misses.
   - The `deploy-manager` agent reads those logs and, through read-only MCP,
     the service and deploy details. It returns a JSON list of `failures`,
     each with a diagnosis. If it lists none, the run ends as
     `deploy_failed`: a failed Render deploy status always stands, whatever the
     agent says.
   - The builder fixes what was diagnosed. `resourceChange()` rejects a
     repair that adds or removes a service or database, because a Blueprint
     sync never deletes a resource and the loop watches only the services it
     already knows.
   - The repair goes through `verify-app` and `publish-app` again, exactly
     like the first build. A repair that changes no files ends the run.
   - The next wait covers only the failed services, with `after` set to the
     deploy that failed. If Render starts no new deploy in 15 minutes, the run
     ends as `deploy_failed`; the old live deploy of a failed service is never
     treated as success.
5. **Smoke-test the live app** in `smokeTest()`. A `live` status means the
   build worked and the health check passed, and the health check is not
   allowed to touch the database. So the workflow checks what a status cannot:
   - `waitForHttpOk()` on the site URL, for up to 10 minutes, because Render
     can take minutes to route a new hostname.
   - `smokeStorefront()` uses `pageContains()` to confirm the API's public
     hostname appears in the storefront's HTML or the same-origin scripts it
     loads.
   - `smokeApi()` checks the health path, then calls `dataCheckPath` with an
     `Origin` header and requires data and a matching
     `access-control-allow-origin` header.

Throughout, `runHeartbeat()` writes progress to the row at most every 30
seconds, so a client always sees what the run is waiting for.

### 9. The run finishes

`awaitDeployment()` returns a `WorkflowResult` with status `deployed`, the app
name, and the URLs. `promptToApp` passes it to `finishRun()`, which sets the
status, sets `stage` to `done`, and frees the concurrency slot. The sandbox is
terminated in the `finally` block.

The client has been polling `GET /v1/apps/:runId`. `readRun()` loads the row,
reconciles it with the task run if needed, and returns it through
`runResponse()`, which redacts `summary` and `progress` and builds the
Dashboard links.

## Key interfaces and types

### `Agent` and `agentTask()`

An agent is data, defined in `app/claude.ts`:

```ts
export interface Agent {
  readonly id: string;            // also the registered task name
  readonly model: ModelTier;      // "medium" | "large"
  readonly prompt: string;
  readonly effort?: Options["effort"];
  readonly tools?: readonly Tool[];          // sandbox tools
  readonly renderTools?: readonly string[];  // read-only Render MCP tools
  readonly maxTurns?: number;
  readonly plan?: string;         // Render Workflows instance plan
}
```

`app/agents.ts` defines the three agents:

| Agent | Tools | Max turns | Returns |
| --- | --- | --- | --- |
| `architect` | Read-only Render MCP | 12 | `DeployPlan` |
| `builder` | Six sandbox tools | 80 | `BuildOutput`: summary and manifest |
| `deploy-manager` | Read-only Render MCP | 20 | A list of failures with diagnoses |

`agentTask(agent)` wraps an agent as a Render Workflows task named after its
`id`. The task receives `{ message, sandboxId?, workDir? }`, connects to the
sandbox if given one, calls `runClaude()` with the agent's settings and its
JSON output schema from `OUTPUT_SCHEMAS`, logs token usage, and returns the
structured output. The sandbox ID and app directory always come from workflow
code, never from a model.

### `runClaude()` and the `PreToolUse` hook

`runClaude()` in `app/claude.ts` is the only place the factory calls the
Claude Agent SDK. The options it sets are the agent's boundary:

- `tools: []` turns off Claude's built-in Bash, Read, Write, and Edit. An
  agent can act only through the tools the factory gives it.
- `allowedTools` lists exactly the granted tools, as
  `mcp__factory__<tool>` for sandbox tools and `mcp__render__<tool>` for
  Render tools.
- `env` forwards only an allowlist of variables (`ENV_ALLOWLIST`) to the
  Claude subprocess. `RENDER_API_KEY` and the GitHub credential are not on it.
- `hooks.PreToolUse` runs `checkToolCall()` from `app/policy.ts` before every
  tool call, and denies the call if it returns a reason.
- The sandbox tools are served from an in-process MCP server bound to one
  sandbox and one `workDir`. The Render tools come from the hosted Render MCP
  server, with the API key in a header that workflow code sets.

`checkToolCall()` denies any Render tool not in `RENDER_READ_ONLY_TOOLS`, so
that list is enforced twice: once as `allowedTools`, once in the hook. For
sandbox tools, it checks each path field with `resolveSandboxPath()`, which
must land inside `workDir` or `/tmp`. It does not inspect shell commands. A
pattern cannot reliably tell a safe command from a harmful one; the sandbox,
which holds nothing worth stealing, is what limits a command.

### `Tool` and `ToolContext`

```ts
export interface ToolContext {
  readonly sandbox: Sandbox;  // bound by workflow code
  readonly workDir: string;   // the app directory
}

export interface Tool<Schema extends ZodShape = ZodShape> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Schema;
  invoke(input: InferShape<Schema>, ctx: ToolContext): Promise<ToolResult>;
}
```

The six tools in `app/tools.ts` are `sandbox__read_file`,
`sandbox__write_file`, `sandbox__list_dir`, `sandbox__search`,
`sandbox__exec`, and `sandbox__apply_patch`. Each resolves its paths against
`ctx.workDir`, so the tool checks paths too, not just the hook.
`sandbox__exec` always starts with `cd` into the app directory, because the
sandbox exec API starts in `/`.

### `DeployPlan`, `Manifest`, and `AppSpec`

Three schemas in `app/contracts.ts` carry an app from idea to deployment:

- **`DeployPlan`** is the architect's output: `appName`, `summary`, `tiers`
  (one to four of `TIER_KINDS`), `assetQueries`, and `brief`.
- **`Manifest`** is the builder's description of what it built: up to six
  `services` (each with `kind`, `rootDir`, `runtime`, `buildCommand`,
  optional `startCommand`, `preDeployCommand`, `staticPublishPath`,
  `healthCheckPath`, `dataCheckPath`, and `envVars` using `fromDatabase` or
  `fromService`), and up to three `databases`. The Blueprint and verification
  both come from the manifest, not the plan.
- **`AppSpec`** is what gets committed as `factory.json`: the manifest plus
  user, app name, prompt, summary, `createdAt`, `resourcePrefix`, and
  `deletedAt` once a delete starts. Storing the prefix means a new default in
  `factory.config.ts` never renames an existing app's resources.

### `rootBlueprint()` and `appBlueprint()`

`app/blueprint.ts` turns specs into YAML, and nothing else creates
infrastructure:

- `appBlueprint(spec)` writes the app's own `render.yaml`, so an app can be
  deployed on its own by pointing a new Blueprint at its folder.
- `rootBlueprint(specs)` writes the repository-root `render.yaml` that Render
  watches: every app that has no `deletedAt`, each as its own project with one
  `production` environment.
- `resourceStem()` and `resourceNames()` name every resource
  `vibe-<user>-<app>-web`, `-api`, `-db`, and so on, so all apps can share one
  workspace without collisions.
- `declaredResources()` lists an app's resources as `name (runtime)`. The
  deploy repair compares these lists.
- `yamlString()` writes each model-supplied value as a fully escaped
  double-quoted scalar. One bad value would otherwise break the root
  Blueprint, and with it the deploy of every app.

Wiring is declarative: `fromDatabase` puts `DATABASE_URL` on the API, and
`fromService` with `envVarKey: RENDER_EXTERNAL_HOSTNAME` puts the API's public
hostname into the storefront build. No factory code ever reads a connection
string.

### `RunStatus`, `RUN_STAGES`, and `WorkflowResult`

In `app/store.ts`, `RunStatus` is the row's status (`running`, `deployed`,
`awaiting_blueprint`, `build_failed`, `deploy_failed`, `failed`, `deleting`,
`delete_failed`). `RUN_STAGES` is the ordered list of progress stages, from
`designing` to `done`. Stages are cosmetic and never gate a run, but the UI's
stage list must match them, and `tests/gateway.test.ts` checks that.

`WorkflowResult` in `app/contracts.ts` is what `prompt-to-app` returns: a
union of `deployed` (with URLs), `awaiting_blueprint`, `build_failed`,
`deploy_failed`, and `failed`, each with a summary.

## Trust boundaries in the code

This section shows where each boundary is enforced in the running system.

- **Internet to gateway.** `bodyLimit`, `bearerAuth` (a constant-time
  comparison), and `basicAuth` in `createGateway()`. The UI routes inject the
  namespace from the Basic Auth user, and `FACTORY_API_KEY` never reaches the
  browser.
- **Gateway to workflows.** The task input is only `prompt`, `user`, and
  `runId`, validated again by `workflowInputSchema`. The gateway holds no
  model or GitHub credential.
- **Agent to machine.** `runClaude()` disables built-in tools, and
  `checkToolCall()` plus each tool's own `resolveSandboxPath()` call keep
  paths in the app directory or `/tmp`. The sandbox itself holds only the app
  being built: `initAppDir()` gives it no clone and no credential.
- **Agent to Render.** `RENDER_READ_ONLY_TOOLS` has no write tool and no log
  tool. Logs can contain secrets, so workflow code fetches them with
  `fetchDeployLogs()` and redacts them before an agent sees them.
- **Agent output to decisions.** Every structured answer is validated by
  `agentJson()` and fails closed after one repair attempt. A failed deploy
  status cannot be overridden by the deploy manager.
- **Build sandbox to GitHub.** `readAppFiles()` and `appFiles()` treat the
  build's files as data. The token is used only in a fresh sandbox from
  `inAppsClone()`, and `pushVerified()` refuses any commit outside the app's
  folder and the root Blueprint.
- **Workflow to the internet.** `downloadImage()` checks protocol, host,
  content type, and size, including on redirects. `pageScripts()` follows only
  same-origin scripts on a generated page, so a model-written page cannot send
  the workflow to other hosts.
- **Workflow to Render infrastructure.** Creation happens only through
  `app/blueprint.ts` and a push. The only Render write calls are the deletes
  in `app/teardown.ts`.
- **Secrets on the way out.** `redactSecrets()` strips secret-shaped strings,
  including anything shaped like a Postgres URL, from API responses and from
  logs placed in task inputs.

## The delete flow

`DELETE /v1/apps/:runId` calls `deleteRun()` in `app/gateway.ts`. A run with
no app name only has a row, so `deleteRunWithoutApp()` removes it. Otherwise
`claimDelete()` marks every run of the app `deleting`, under the same per-app
advisory lock that `claimRunApp()` uses, and refuses while a run of the app is
still running. Then the gateway starts the `delete-app` task.

`deleteApp` in `app/workflow.ts` calls `removeApp()`, which runs four
subtasks from `app/delete.ts` in a fixed order:

```ts
const removed = await tasks.run(removeFromBlueprintTask, app);
if (removed) {
  await tasks.run(waitForSyncsTask, { ...app, pushedAt: removed.pushedAt });
  deleted = await tasks.run(deleteResourcesTask, { ...app, resourcePrefix: removed.resourcePrefix });
}
await tasks.run(removeFilesTask, app);
```

The order follows from two facts about Blueprints: a Blueprint change never
deletes a resource, and a sync recreates any declared resource that is
missing.

1. **`remove-app-from-blueprint`** sets `deletedAt` in the app's
   `factory.json` and pushes a regenerated root Blueprint that leaves the app
   out. It removes no source files yet. A commit that removed a service's
   files would trigger a build of that service, which would fail.
2. **`wait-for-blueprint-syncs`** calls `waitForBlueprintSyncs()` in
   `app/teardown.ts`. It waits a minute for the push event, then until no sync
   of the apps Blueprint is pending or running, for up to 6 minutes. Only a
   sync of an earlier commit still declares the app, and such a sync would
   recreate what the next step deletes. The Blueprint's list of managed
   resources is not a usable signal: a push that only removes resources starts
   no sync, and Render keeps listing them.
3. **`delete-app-resources`** calls `deleteAppResources()`, which finds the
   project named `vibe-<user>-<app>`, deletes the services and then the
   databases whose names start with that stem, and then deletes the project.
   A resource with any other name is kept and logged, and the delete stops
   before it deletes the project.
4. **`remove-app-files`** removes the app's folder in a second commit.

The resource names come from `factory.json`, so the files must outlive the
resources. Every step reads the state an earlier attempt left, so a failed
delete can simply be started again. If `deleteApp` succeeds, it calls
`deleteRuns()`. If it fails, `failDelete()` sets `delete_failed` with the
reason.

## State and reconciliation

All cross-process state is one Postgres table, `runs`, defined in
`app/schema.sql` and applied idempotently by `npm run db:migrate`. Render
filesystems are ephemeral, so nothing important lives on disk.

- **Claims.** `claimRun()` enforces idempotency (a unique key) and the
  concurrency cap (a conditional insert under an advisory lock).
  `claimRunApp()` and `claimDelete()` share a per-app advisory lock, taken by
  `withAppLock()` with `pg_advisory_xact_lock`, so a run cannot start building
  an app that is being deleted, and two runs cannot build the same app.
- **Progress.** `setRunStage()` records each stage and its start time in
  `stage_history`. `touchRun()` updates `progress` during long waits. The
  gateway computes each stage's end time from the next stage's start.
- **Reconciliation.** A task that times out, crashes, or is canceled never
  reaches its own catch block, so its row would stay `running`. Whenever a
  client reads a run, or the UI lists runs, `reconcileWorkflowRun()` in
  `app/gateway.ts` asks Render Workflows for the task run's status (throttled
  by `claimWorkflowCheck()` to once per 30 seconds per run). A failed or
  canceled task marks the row `failed`, or `delete_failed` for a delete. A
  task that succeeds always writes its result before returning, so success
  needs no reconciliation.
- **Retries.** `prompt-to-app`, `verify-app`, `publish-app`, `delete-app`,
  and each delete step set `maxRetries: 0`, because a blind retry of any of
  them can repeat side effects or hide a failure. Agent subtasks keep
  Render's default retries: the parent is waiting, so the row stays `running`.
  Inside a run, transient faults are retried at the level of one call:
  `retryRead()` in `app/render.ts` retries Render reads up to five times (but
  not a 401 or 403), and `pushVerified()` retries a rejected push on the new
  tip.

There is no step-level resume today: a failed top-level run is final, and the
caller submits the prompt again. An implementation that adds resumability
would start with Render Workflows' `ctx.step()`.

## How the tests are organized

`npm run check` runs Biome, `tsc`, and Vitest. CI runs it on every pull
request, and a second CI job builds both halves of `templates/fullstack`. No
test calls a live Render, GitHub, Postgres, model, or Commons API.

The suite is small on purpose: about a hundred tests, each named for a
behavior. Tests go through public entry points (HTTP routes, task bodies,
exported functions), fake only the systems at the edge, and assert what a
user or operator would see, not how the code gets there. Where it is cheap,
they run the real thing: git, tar, and a shell in temporary directories.

Most modules have a matching file in `tests/`:

- **Contracts and generation:** `blueprint.test.ts` is the contract for
  what gets deployed. `contracts.test.ts` covers the schemas and
  `agentJson()`. `templates.test.ts` keeps the template and the builder's
  instructions in sync.
- **Boundaries:** `agents.test.ts` is the executable access review: which
  agent gets which tools. `policy.test.ts` covers `checkToolCall()`, path
  resolution, the MCP allowlist, and redaction. `tools.test.ts` covers the
  sandbox tools.
- **Git and files:** `git.test.ts` runs real `git` against a local remote
  to check what a commit holds, which pushes are refused, and how a push
  recovers when another run pushed first. `files.test.ts` copies an app's
  files between two real clones and checks which files are refused.
  `github-auth.test.ts` covers the GitHub App and token paths.
- **Render and the outside world:** `render.test.ts`, `teardown.test.ts`,
  and `images.test.ts` use stubbed `fetch` responses.
- **The gateway:** `gateway.test.ts` covers authentication, validation,
  dispatch, status, delete, reconciliation, and the UI, including that the
  stage list in `public/index.html` and `public/table.html` matches
  `RUN_STAGES`.
- **The pipelines:** `workflow.test.ts` drives `promptToApp`,
  `awaitDeployment`, `removeApp`, and `deleteApp` with mocked agents, store,
  sandbox, and Render reads. It is where the deploy repair loop and the delete
  order are tested.
- **Processes and state:** `host.test.ts` starts `app/host.ts` in a real
  Node process against a fake task server to prove every task registers.
  `store.test.ts` checks, with fake clients, that a run claim holds its
  lock and that a lost Postgres connection does not crash the process.

To run one file: `npx vitest run tests/blueprint.test.ts`.
