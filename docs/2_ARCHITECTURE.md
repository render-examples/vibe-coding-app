# Architecture

This document maps the repository, traces app creation and deletion, and
describes the contracts between the gateway, workflow, agents, Sandboxes,
GitHub, and Render.

For setup, use [0_QUICKSTART.md](0_QUICKSTART.md). For supported changes, use
[1_EXTENSION.md](1_EXTENSION.md).

## System overview

The factory has two independently deployed processes and one shared
database:

- **Gateway**: an internet-facing Hono web service that authenticates
  callers, validates requests, claims runs in Postgres, dispatches workflow
  tasks, and serves the browser UI.
- **Workflows host**: registers the app-building and deletion tasks. It calls
  models, creates Sandboxes, verifies code, publishes to GitHub, observes
  deploys, and performs scoped deletion.
- **Factory Postgres**: stores run ownership, status, progress, task IDs,
  app identity, URLs, and concurrency claims.

Generated apps use a separate GitHub repository:

```text
Caller
  │
  ▼
Gateway ───────▶ Factory Postgres
  │
  │ start prompt-to-app
  ▼
Workflows host ─────▶ Build Sandbox
  │                       │
  │                       └─ agents build; workflow verifies
  │
  └──────────────────▶ Publish Sandbox ──▶ Apps repository
                                                │
                                                │ Blueprint Auto Sync
                                                ▼
                                  Generated Render project
                                  (site, optional API, optional Postgres)
```

The split is a security boundary. The public gateway has no model key or
GitHub credential. The build Sandbox has no factory credential or clone of
the apps repository. Publishing happens in a fresh Sandbox no agent has used.

## Directory overview

```text
factory.config.ts             Non-secret factory defaults and resource naming
render.yaml                   Blueprint for the factory itself
docker-compose.yml            Local Postgres
.env.example                  Environment variable reference
AGENTS.md                     Contributor conventions and canonical invariants
docs/
  0_QUICKSTART.md             Setup, first app, deployment, operations, cleanup
  1_EXTENSION.md              Supported customization paths
  2_ARCHITECTURE.md           Repository map, execution paths, interfaces
  3_TAKEAWAYS.md              Reusable design lessons
app/
  server.ts                   Gateway process entrypoint
  host.ts                     Workflows process entrypoint and task registration
  gateway.ts                  HTTP auth, routes, dispatch, status, reconciliation
  workflow.ts                 prompt-to-app and delete-app narratives
  build.ts                    Builder and verification repair rounds
  verify.ts                   Pre-publish build, boot, database, and file checks
  publish.ts                  Trusted clone, spec generation, commit, and push
  deploy.ts                   Deploy waits, repairs, and public smoke tests
  delete.ts                   Four restartable delete subtasks
  agents.ts                   Agent definitions and task wrappers
  claude.ts                   Claude SDK boundary and structured-output repair
  tools.ts                    Builder's scoped Sandbox tools
  policy.ts                   Tool allowlist, path policy, and secret redaction
  contracts.ts                Zod schemas and shared TypeScript contracts
  store.ts                    Postgres state, idempotency, and advisory locks
  schema.sql                  runs table schema
  sandbox.ts                  Render Sandbox lifecycle and Sandbox Postgres
  git.ts                      Clone, stage, commit, push, and remote verification
  files.ts                    Copy app files between Sandboxes as untrusted data
  github.ts                   GitHub App and personal-token authentication
  blueprint.ts                Validated manifest to Render Blueprint
  render.ts                   Render reads, deploy logs, retries, and HTTP probes
  teardown.ts                 Scoped Render resource deletion
  templates.ts                Materialize a template in the build Sandbox
  images.ts                   Bounded Wikimedia search and download
  config.ts                   Environment parsing and process-specific validation
public/
  index.html, app.js           Stage-oriented UI
  table.html, table.js         Tabular UI
  runs.js                     Shared rendering and polling helpers
templates/fullstack/
  web/                        Vite + React storefront
  api/                        Hono + Postgres API
scripts/
  migrate.ts                  Apply app/schema.sql
  doctor.ts                   Read-only configuration and integration diagnostics
  demo.ts                     Submit and poll a prompt
  support.ts                  Shared script helpers
tests/                        One Vitest suite per behavior boundary
```

Imports generally flow in one direction:

```text
sandbox → tools → claude → agents → stages → workflow
```

The stage modules are `build`, `verify`, `publish`, `deploy`, and `delete`.
Supporting modules such as `contracts`, `policy`, `store`, and `sandbox` stay
low in the graph. A dependency from a lower-level boundary back into the
workflow is a design smell.

## Process entrypoints

### Gateway

[`app/server.ts`](../app/server.ts) validates gateway-only configuration,
creates the Hono application from `createGateway()`, and binds to
`0.0.0.0:$PORT`.

The public routes are:

- `GET /health`: process liveness.
- `GET /ready`: Postgres readiness.
- `POST /v1/apps`: start an app run with bearer authentication.
- `GET /v1/apps/:runId`: read and reconcile a run.
- `DELETE /v1/apps/:runId`: delete the run's app.
- `/ui/*`, `/`, and `/table`: Basic-Auth browser surface scoped to
  `UI_USERNAME`.

The gateway holds `FACTORY_API_KEY`, `RENDER_API_KEY`, and `DATABASE_URL`, but
not the model or GitHub credentials.

### Workflows host

[`app/host.ts`](../app/host.ts) validates workflow-only configuration and
synchronously imports the task graph. Render's SDK starts the task server
after task registration begins, so all task modules must register in the same
initial import pass. `tests/host.test.ts` verifies the complete task list in a
real Node process.

The workflows host holds the model, GitHub, Render, and database credentials.
It is not an HTTP service exposed to users.

## Core execution paths

### Prompt to live app

#### 1. Authenticate, validate, and claim

`POST /v1/apps` passes through bearer authentication and a 64 KB body limit.
`createRun()` in [`app/gateway.ts`](../app/gateway.ts):

1. Parses the body with `createAppRequestSchema`.
2. Generates a run ID.
3. Calls `claimRun()` in `app/store.ts`.
4. Dispatches the `prompt-to-app` task with `{ prompt, user, runId }`.
5. Stores the returned task-run ID and returns `202`.

`claimRun()` handles two races in one Postgres transaction:

- a unique idempotency key makes retried requests return the original run;
- a transaction-scoped advisory lock serializes the conditional insert that
  enforces `maxConcurrentRuns`.

UI submissions take their `user` from authenticated `UI_USERNAME`, never
from the browser body.

#### 2. Design the app

`promptToApp` in [`app/workflow.ts`](../app/workflow.ts) validates the task
input again and calls the `architect` subtask.

The architect can inspect the Render workspace through read-only MCP tools.
It returns a `DeployPlan`: app name, summary, required primitives, asset
queries, and a product brief. `agentJson()` validates the response with Zod,
asks for one schema repair if needed, and then fails closed.

`claimRunApp()` records the app name under a per-app advisory lock. It refuses
to build an app currently being built or deleted.

#### 3. Prepare an isolated build Sandbox

The workflow creates one Render Sandbox and saves its ID for Dashboard links.
`initAppDir()` creates:

```text
/home/user/repo/apps/<user>/<app>
```

The enclosing Git repository has no remote. The Sandbox receives no GitHub
token. The builder may execute arbitrary shell commands, so the absence of
credentials and unrelated source is the real boundary.

When the plan includes them, trusted workflow code:

- installs a real Postgres inside the Sandbox;
- materializes `templates/fullstack`; and
- downloads bounded, allowlisted Wikimedia images into the app.

The Sandbox is terminated in a `finally` block.

#### 4. Build and verify

`buildAndVerify()` alternates between the `builder` agent and the
`verify-app` subtask:

1. The builder edits the app through six scoped Sandbox tools and returns a
   `BuildOutput`.
2. `verify-app` validates and executes the declared `Manifest`.
3. Failures are sent back to the builder for a bounded number of repair
   rounds.

Verification deliberately models a fresh deployment:

- write the generated `.gitignore` and remove ignored outputs;
- run each service's build command;
- require a substantial `index.html` for static sites;
- boot web services with an unreachable database and check health;
- run idempotent migrations against Sandbox Postgres;
- boot again and require non-empty data from `dataCheckPath`; and
- read the app through the same file-transfer boundary publishing uses.

A failed verification produces `build_failed`; it never publishes.

#### 5. Publish from a clean Sandbox

The workflow turns the verified manifest into an `AppSpec`, which becomes
`factory.json`.

`publish-app` then crosses the trust boundary:

1. `readAppFiles()` packs only commit-visible files from the build Sandbox.
2. `appFiles()` accepts regular files with safe relative paths under a 50 MB
   total cap.
3. `inAppsClone()` creates a fresh Sandbox, obtains a short-lived GitHub
   credential, and clones the apps repository.
4. Trusted code writes the app files, `factory.json`, the app-local
   `render.yaml`, and a regenerated repository-root `render.yaml`.
5. Git stages only `apps/<user>/<app>/` and the root Blueprint.
6. `pushVerified()` rejects any other changed path, pushes, and confirms the
   remote branch points at the expected commit.

Concurrent pushes retry on the newest branch tip. The root Blueprint is
regenerated from all committed `factory.json` files rather than merged.

#### 6. Wait for Render and repair bounded failures

Render's apps Blueprint sees the push and creates or updates the app project.
`awaitDeployment()`:

1. Finds the Blueprint watching the configured repository, branch, and path.
2. Returns `awaiting_blueprint` if no such Blueprint exists.
3. Waits for every expected service to appear.
4. Waits for deploys caused by the new commit.
5. On a failed deploy, fetches and redacts that deploy's logs, asks the
   `deploy-manager` for a diagnosis, and gives the diagnosis to the builder.
6. Re-verifies and republishes a bounded repair.

The first wait records deploy IDs before publishing so an old live deploy
cannot be mistaken for the result of the new commit. A repair waits only for
deploys newer than the failed deploy.

The deploy manager is advisory. An empty diagnosis cannot override a failed
Render deploy status, and a repair cannot change the declared set or runtime
of resources.

#### 7. Smoke-test the public application

A `live` deploy status proves the build and health check succeeded. It does
not prove the browser-to-API path works.

The workflow additionally checks:

- the public site responds;
- the storefront bundle contains the API's public hostname;
- the API health path responds;
- the data path returns rows; and
- CORS permits the storefront origin.

Only then does the run finish as `deployed`. `finishRun()` records the final
status, sets the stage to `done`, and releases the concurrency slot.

### Delete an app

Deletion is per app because all runs with the same user and app name share
files and resources.

`DELETE /v1/apps/:runId`:

1. Loads the run and checks the UI namespace when applicable.
2. Claims every run of the app under the same per-app advisory lock used by
   builds.
3. Refuses deletion while a build of that app is active.
4. Dispatches `delete-app`.

`removeApp()` runs four restartable subtasks in order:

1. **Remove from Blueprint.** Set `deletedAt` in `factory.json`, regenerate
   the root Blueprint without the app, and push. Keep source files for now.
2. **Wait for Blueprint syncs.** Wait until no older pending or running sync
   can recreate resources that the next step deletes.
3. **Delete resources.** Delete only services and databases in the app's
   project whose names start with the app's stored resource stem, then delete
   the empty project.
4. **Remove files.** Delete the app directory and push a second commit.

A Blueprint sync creates declared resources but does not delete resources
removed from YAML. That asymmetry determines the order. If a delete fails,
the next request starts from step one and each step reads the state left by
the previous attempt.

## Core interfaces

### `Agent` and `agentTask()`

`Agent` in [`app/claude.ts`](../app/claude.ts) defines an agent as data:

```ts
interface Agent {
  id: string;
  model: "medium" | "large";
  prompt: string;
  effort?: Options["effort"];
  tools?: readonly Tool[];
  renderTools?: readonly string[];
  maxTurns?: number;
  timeoutSeconds: number;
  plan?: string;
}
```

`agentTask()` in `app/agents.ts` turns that definition into a Render task. It
binds a workflow-selected Sandbox and working directory when needed, calls
`runClaude()`, logs token usage, and returns structured output. Every agent
task has an explicit deadline and disables automatic task retries.

`runClaude()` is the model boundary. It disables built-in shell and file
tools, forwards an environment allowlist, exposes only explicitly selected
MCP tools, and runs `checkToolCall()` before every tool call.

### `Tool` and `ToolContext`

```ts
interface ToolContext {
  readonly sandbox: Sandbox;
  readonly workDir: string;
}

interface Tool<Schema extends ZodShape = ZodShape> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Schema;
  invoke(input: InferShape<Schema>, ctx: ToolContext): Promise<ToolResult>;
}
```

Workflow code binds the context; the model supplies only validated tool
input. File tools resolve paths inside `workDir` or `/tmp`.

The builder receives read, write, list, search, exec, and patch tools. The
architect and deploy manager receive no Sandbox tools. Builder shell commands
have their own 10-minute limit, shorter than the builder task and parent
workflow deadlines.

### `DeployPlan`, `Manifest`, and `AppSpec`

These Zod-validated contracts carry an app through the system:

- `DeployPlan`: what the architect proposes—name, primitives, assets, and
  product brief.
- `Manifest`: what the builder actually created—services, commands, paths,
  environment references, and databases.
- `AppSpec`: durable `factory.json`—identity, prompt, summary, prefix,
  manifest, and optional deletion marker.

The plan guides the build, but the manifest drives verification and
deployment. The AppSpec is the source from which root Blueprint state can be
reconstructed.

### `Sandbox`

The `Sandbox` class in [`app/sandbox.ts`](../app/sandbox.ts) wraps the
operations used by workflow and tools: wait, run commands, upload and
download files, read and write files, list directories, and terminate.

Agent code never creates or selects a Sandbox. Workflow code creates it and
passes only its ID to subtasks that must reconnect.

### `RunRecord`, `RunStatus`, and `WorkflowResult`

`RunRecord` in [`app/store.ts`](../app/store.ts) is the durable status model.
It contains the prompt, namespace, status, current stage, progress, stage
history, workflow and Sandbox IDs, app name, URLs, summary, and timestamps.

Terminal prompt-run statuses are:

- `deployed`
- `awaiting_blueprint`
- `build_failed`
- `deploy_failed`
- `failed`

Deletion uses `deleting` and `delete_failed`; successful deletion removes the
rows.

`WorkflowResult` in `app/contracts.ts` is the task-level union returned by
`prompt-to-app`. `finishRun()` projects that result into Postgres for polling
clients.

### Blueprint functions

[`app/blueprint.ts`](../app/blueprint.ts) is the only infrastructure-creation
path:

- `appBlueprint(spec)` creates an app-local Blueprint.
- `rootBlueprint(specs)` creates the multi-app Blueprint watched by Render.
- `resourceNames()` gives every resource a collision-resistant,
  app-scoped name.
- `declaredResources()` defines the resource identity held fixed during a
  deploy repair.

Model-authored strings are emitted as escaped YAML scalars. Agents never
write the Blueprint directly.

## State and reconciliation

All cross-process state lives in the `runs` Postgres table. Render
filesystems are ephemeral.

The store uses:

- a unique idempotency key for safe request retries;
- one global advisory lock for concurrency claims;
- per-app advisory locks shared by builds and deletes;
- append-only stage-history entries for timing; and
- progress heartbeats during long waits.

A task can time out or be canceled before its catch block records a result.
When the API reads or lists active runs, `reconcileWorkflowRun()` checks the
Render task-run status and marks orphaned rows failed. Checks are throttled so
UI polling does not hammer the Render API.

Top-level workflow tasks do not retry blindly. Transient operations retry at
the narrowest safe level, such as a Render read or a rejected concurrent Git
push.

## Trust boundaries

The important boundaries are:

- **Internet → gateway:** authentication, body cap, Zod validation, namespace
  injection, and response redaction.
- **Gateway → workflow:** only `{ prompt, user, runId }`, validated again.
- **Agent → machine:** explicit tools, pre-tool policy, scoped paths, and a
  credential-free Sandbox.
- **Agent → Render:** read-only MCP allowlist; no direct log access.
- **Agent output → workflow:** schema validation and deterministic pass/fail
  checks.
- **Build Sandbox → GitHub:** regular-file transfer as untrusted data, then a
  clean credentialed publish Sandbox.
- **Workflow → infrastructure:** validated Blueprint creation; scoped API
  deletion only after the app leaves the Blueprint.

The full, normative list is in [AGENTS.md](../AGENTS.md#invariants).

## Tests

`npm run check` runs linting, TypeScript, and Vitest. No test calls a live
model, Render workspace, GitHub repository, Postgres instance, or Commons
API.

The suite tests public behavior and boundaries:

- `gateway.test.ts`: auth, validation, dispatch, status, reconciliation, UI.
- `workflow.test.ts`: create, repair, deploy, and delete orchestration.
- `blueprint.test.ts`: generated infrastructure contract.
- `agents.test.ts`, `policy.test.ts`, `tools.test.ts`: capability boundaries.
- `git.test.ts`, `files.test.ts`, `github-auth.test.ts`: publish boundary.
- `render.test.ts`, `teardown.test.ts`, `images.test.ts`: external systems.
- `store.test.ts`: claims, locks, and connection failure behavior.
- `host.test.ts`: synchronous registration of every workflow task.
- `templates.test.ts`: template and builder-instruction alignment.

Where practical, tests use real local Git, tar, shells, and temporary
directories, while faking only the network edge.
