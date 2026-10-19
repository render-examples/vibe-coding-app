# Repository guide for agents and contributors

This file applies to the entire repository. It holds the conventions, the
invariants (the canonical list of safety boundaries), and the checklists for
changing the code. For setup, read [docs/QUICKSTART.md](docs/QUICKSTART.md).
For a guided tour of the code, read [docs/WALKTHROUGH.md](docs/WALKTHROUGH.md).

## What this is

`vibe-code-demo` turns one authenticated prompt into a deployed application on
Render. It is a reference architecture for wiring a vibe-coding product to
Render Workflows, Sandboxes, Blueprints, Postgres, and the Render MCP server.
It is written to be read, not to be a framework.

A caller posts a prompt. The gateway validates it and starts the
`prompt-to-app` workflow task. The workflow designs the app against Render
primitives, downloads openly licensed photos, and has an agent build the app in
an isolated sandbox. The `verify-app` subtask checks the build, and the
`publish-app` subtask copies it into a clone of the apps repository in a
separate sandbox and commits it with a Blueprint that Render deploys.

A delete runs the other way. `DELETE /v1/apps/:runId` claims every run of
that run's app, and the `delete-app` task runs one subtask per step: take the
app out of the Blueprint, wait until no Blueprint sync can bring its resources
back, delete the resources, and remove its files.

Two processes deploy independently:

- `app/server.ts`: the Hono gateway web service.
- `app/host.ts`: the Render Workflows host, which registers every task.

The gateway runs no models, holds no repository credential, and creates or
deletes no infrastructure. Agents never write to GitHub and never call a
Render write API. Only `publish-app` and the two pushing steps of `delete-app`
write to GitHub. The only Render write calls are the deletes in
`app/teardown.ts`, made only by the `delete-app-resources` step. Code that
agents write runs in a Render Sandbox that holds only the app being built,
with no clone of the apps repository and no credential. Each push clones the
repository in a separate sandbox that no agent uses.

## Running and verifying changes

Setup is in [docs/QUICKSTART.md](docs/QUICKSTART.md). The commands you need
while changing code:

- `npm run check` runs Biome, `tsc`, and Vitest. Run it before you finish.
- `npx vitest run tests/blueprint.test.ts` runs one file.
- `render blueprints validate` validates this repository's `render.yaml`.
  Run it when you change that file.
- `npm run doctor` diagnoses a live deployment and is read-only. When you add
  a required environment variable, a task name, or a schema object, add a
  check for it there. That script is where setup mistakes get caught.
- `npm run demo` runs the end-to-end demo against a live gateway.

Production entrypoints are `npm run start:gateway` and
`npm run start:workflows`.

Environment gotchas:

- `npm run dev:gateway` sets `RENDER_USE_LOCAL_DEV=true`, so the local gateway
  starts tasks on the `dev:workflows` task server, which finds a task by name
  and ignores the slug. Set that variable only there, never in `.env`: the
  workflows host also loads `.env` and must use the Render API.
- `render.yaml` creates both services and the database in the `vibe-factory`
  project, and sets the gateway's `RENDER_WORKFLOW_SLUG` from the workflow
  with `fromService`. Keep that environment's network isolation off: an
  isolated workflow cannot reach the database.
- The workflow service in `render.yaml` sets `repo:` to the upstream
  repository, because a workflow service in a Blueprint needs it. A fork must
  change it to the fork's URL.
- The apps repository needs a one-time Blueprint watching `main:render.yaml`
  with Auto Sync on, in the `RENDER_WORKSPACE_ID` workspace. `findBlueprint()`
  looks only there.

## The HTTP API and browser UI

The gateway listens on `0.0.0.0:${PORT:-3000}`. `GET /health` is liveness,
`GET /ready` checks Postgres and is the Render health check, prompts arrive at
`POST /v1/apps`, runs are read at `GET /v1/apps/:runId`, and
`DELETE /v1/apps/:runId` deletes the run's app with all of its runs. The full
reference is in [docs/README.md](docs/README.md#http-api).

The browser UI at `/` and `/table` is protected by HTTP Basic Auth
(`UI_USERNAME`, `UI_PASSWORD`) and submits through `/ui/apps`, which keeps
`FACTORY_API_KEY` on the server. Rules for UI changes:

- Do not add a browser route that bypasses Basic Auth.
- The signed-in `UI_USERNAME` is a validated lowercase slug and is injected as
  the app namespace. Never accept a `user` from the browser.
  `GET /ui/apps` lists only that namespace's runs, and
  `DELETE /ui/apps/:runId` deletes only a run in that namespace.
- Postgres is the source of truth. The UI restores the selected run from
  local storage, but renders from the server's list.
- The UI polls only `GET /ui/apps`, every 5 seconds while a run or delete is
  in progress, and renders the history and the selected run from that list.
  So the list handler must reconcile each task-owned run, as
  `GET /ui/apps/:runId` does.
- Keep a submit error in the form and a delete error in its dialog. Each
  refresh re-renders the run panel and would erase an error shown there.
- Runs build in parallel, up to `maxConcurrentRuns`. The UI disables the
  submit button only while the gateway is accepting a prompt.

The two views share `public/runs.js`; `app.js` (classic view, `index.html`)
and `table.js` (table view, `table.html`) render only what differs. Each view
links to the other. `setRunStage()` appends each stage a run enters, with its
start time, to `stage_history`, and the gateway gives each item an end time:
when the next item started, or when the run stopped. A stage entered more than
once, such as building after a failed verification, shows the sum of its
times. The gateway builds Dashboard links from IDs in Postgres and returns
`null` for a link it cannot make: the SDK does not return subtask run IDs, so
every stage links to the `prompt-to-app` run, and a workspace with more than
one sandbox group gets no sandbox link.

## Repository map

Each concern is one file under `app/`. There are no barrels, no path aliases,
and no SDK wrapper layer. Imports are relative, with `.js` extensions
(NodeNext).

Imports flow one way:

```text
sandbox → tools → claude → agents → stages → workflow
```

The stages are `build`, `verify`, `publish`, `deploy`, and `delete`.
`workflow` runs them. `deploy` uses `build`, `verify`, and `publish`; `build`
uses `verify`; `delete` uses `publish`.

The supporting modules:

- `contracts`, `policy`, `store`, and `sandbox` import nothing else in `app/`.
  `config` imports only the `slug` schema from `contracts`.
- `policy` defines the MCP allowlist and the path and redaction rules. `tools`,
  `claude`, `agents`, `deploy`, and `gateway` import it.
- `render` is imported by `claude` (for the MCP URL), `deploy`, `delete`,
  `teardown`, and `gateway` (for the workflow ID in Dashboard links).
- `git` (clone, commit, push), `files` (copying an app's files as data), and
  `github` (credentials) are used by the stages: `publish` uses all three,
  `verify` uses `git` and `files`, and `workflow` uses `git` for
  `initAppDir()`.
- `blueprint`, `images`, `templates`, `teardown`, and `store` are used by
  `workflow` and the stages. `teardown` uses `render` and `blueprint`.
- `gateway` uses `store`, `policy`, `contracts`, `config`, and `render`.

Adding an import that points backwards is a design smell.

```text
factory.config.ts   Directories, branch, plans, asset hosts, concurrency cap, model tiers
app/
  config.ts      Environment parsing and per-process validation
  contracts.ts   Zod schemas for API input, agent output, and the stored spec
  gateway.ts     Auth, body cap, dispatch, status, reconciliation, run formatting
  agents.ts      The three agents, their prompts, and agentTask()
  claude.ts      The Agent type, runClaude(), md, agentJson()
  tools.ts       The sandbox tools and the Tool contract
  policy.ts      checkToolCall(), path rules, the MCP allowlist, redactSecrets()
  sandbox.ts     Render Sandboxes, shellEscape, Postgres in the sandbox
  blueprint.ts   render.yaml generation: the only path that creates resources
  render.ts      REST reads of services, deploys, logs, and Blueprints; HTTP probes
  teardown.ts    The deletes of a deleted app: the only Render write API calls
  git.ts         Clone, commit, push and verify, .gitignore generation,
                 initAppDir(), removeIgnored()
  files.ts       readAppFiles(), appFiles(), writeAppFiles(), MAX_APP_BYTES:
                 copying an app's files between sandboxes as data
  github.ts      GitHub App JWT and installation tokens, the PAT fallback:
                 githubToken(), usingGitHubApp()
  store.ts       Postgres: the runs table, claims, and app locks
  templates.ts   Read a template and write it into the sandbox
  images.ts      Photos from Wikimedia Commons for an app
  workflow.ts    The prompt-to-app and delete-app pipelines
  build.ts       The builder rounds with verify-app, and the builder's message
  verify.ts      verify-app: build, boot, and query the app; runVerification()
  publish.ts     publish-app, and each clone, change, commit, and push
  deploy.ts      The deploy wait, the deploy repair, and the smoke checks
  delete.ts      The four steps of delete-app
  schema.sql     Schema, applied by scripts/migrate.ts
  server.ts      Gateway entrypoint
  host.ts        Workflows entrypoint
public/          The Basic Auth UI: runs.js (shared), index.html + app.js
                 (classic view), table.html + table.js (table view)
templates/
  fullstack/     web/ (Vite + React + Tailwind + shadcn/ui), api/ (Hono + pg)
scripts/         migrate, doctor, demo, support
tests/           agents, blueprint, contracts, files, gateway, git,
                 github-auth, host, images, policy, render, shell, store,
                 teardown, templates, tools, workflow
```

There is no `tasks.ts`, `scaffold.ts`, `shell.ts`, or `format.ts`.
`agentTask()` lives in `agents.ts`, `shellEscape` sits beside the only code
that executes a command in `sandbox.ts`, and run formatting is in
`gateway.ts`. The builder chooses its own stack, so there is no skeleton to
scaffold: the manifest it returns is what gets deployed.

## Conventions

- Strict TypeScript, ESM, NodeNext. Include `.js` in relative imports.
- Validate external and workflow input with Zod before using it.
- Use `md` for dedented multi-line prompts.
- Escape shell arguments with `shellEscape`. Use `execGitWithToken` for
  authenticated Git.
- Write each free-form manifest value into a Blueprint with `yamlString`. One
  value that breaks the YAML stops the deploy of every app in the root
  Blueprint.
- Keep task inputs and results small and JSON-serializable. The Dashboard
  shows them.
- Comments explain intent and constraints, not what the next line does.
- Add or update tests with every behavior change. Tests never call live
  Render, GitHub, Postgres, model, or Commons APIs.
- Test behavior, not implementation: go through public entry points, fake
  only the systems at the edge, and assert what a user or operator sees, not
  exact messages, SQL text, or call counts. One test per behavior, named as a
  sentence. Keep the suite near a hundred tests; replace a test rather than
  add a near-duplicate.
- Helpers that outgrow a file belong in a new `app/<concern>.ts`, not in a
  subdirectory.

## Invariants

This is the canonical list of the factory's safety boundaries. Other documents
link here instead of restating it. Do not weaken any of these without an
explicit change to the security model, and update this list when you change
one.

**Gateway and input**

- One deployment is bound to one validated `APPS_REPO` and one branch.
- Only a request with the correct bearer token starts a run, and the token is
  compared in constant time.
- Browser requests require valid Basic Auth. The UI handlers reuse the same
  validation and claim path as `/v1`, and no HTML or JavaScript response
  contains the factory bearer token.
- The body is capped before it is parsed.
- The UI submits, lists, and deletes only in its own `UI_USERNAME`
  namespace.
- The gateway never receives the GitHub credential or the Anthropic key.
- Secret-shaped strings, including anything shaped like a Postgres
  connection string, are redacted from everything the API returns.

**Agents and tools**

- Agents receive only the tools listed in their definition. Claude's
  built-in Bash, Read, Write, and Edit are never granted: `runClaude()` always
  passes `tools: []`.
- The Claude subprocess gets only the environment variables in
  `ENV_ALLOWLIST`, which has no Render or GitHub credential.
- Only the builder gets sandbox tools.
- The architect and the deploy manager get only Render MCP tools from
  `RENDER_READ_ONLY_TOOLS`. `checkToolCall()` denies every other Render tool,
  so the allowlist is enforced twice.
- No agent reads Render logs. `RENDER_READ_ONLY_TOOLS` has no log tool, so
  `checkToolCall()` denies `list_logs` too. Logs can hold secrets, and the
  factory cannot redact what an agent reads directly. In a deploy repair
  round, workflow code reads each failed deploy's logs with
  `fetchDeployLogs()` and gives them to the deploy manager in its input. The
  Dashboard shows every task input, so `failedDeployReport()` applies
  `redactSecrets()` first and only then cuts the logs to
  `MAX_DEPLOY_LOG_CHARS`. Do not cut first: a cut can split a secret, and the
  redaction cannot find half of one.
- Every agent-supplied path is resolved against the workflow-owned `workDir`
  on `ToolContext`, which is the app directory, and must land inside it or
  `/tmp`. Both `checkToolCall()` and the tool itself check this.
  `sandbox__exec` always `cd`s into the app directory first: the exec API
  starts in `/`, and a relative path would otherwise build an app outside the
  directory that gets committed. These rules keep the file tools on one app,
  but they cannot limit a shell command. The next invariant does that.
- `checkToolCall()` does not inspect shell commands. A pattern cannot tell a
  safe command from a harmful one; the sandbox's contents limit what a command
  can reach.
- `sandboxId` and `workDir` come from workflow code, never from a model.
- Structured agent output is validated with Zod and fails closed after one
  repair attempt (`agentJson()`).
- A failed Render deploy status is never overridden by an agent. If the
  deploy manager lists no failures, the run ends as `deploy_failed`.

**The build sandbox**

- The sandbox the agents and `verify-app` use holds only the app being
  built. `initAppDir()` creates the app directory in a repository with no
  remote. No clone of the apps repository and no credential ever enters that
  sandbox: the builder can run any command there, leave a process running,
  and modify `git` itself.
- The agent-authored build, pre-deploy, and start commands run only in that
  sandbox and in the app's own services on Render. Neither place holds a
  factory credential.
- The image download in `app/images.ts` accepts only HTTPS, only hosts in
  `factoryConfig.assets.allowedHosts`, and only `image/*` responses. It
  follows redirects itself and checks the protocol and host of every hop
  (`allowedUrl()`), refuses a declared length over `assets.maxBytes`, and
  stops reading once the body passes it. It writes only into the app's
  `assets/` directory, under a name the code makes.

**Publishing**

- The GitHub token never goes into a task input, because the Dashboard shows
  every task input, and never into the build sandbox.
- `publish-app` reads the app's files from the build sandbox as data.
  `readAppFiles()` packs what a commit of the app directory would hold, and
  `appFiles()` accepts only regular files with plain paths below it, up to
  `MAX_APP_BYTES`. Then `publish-app` gets the token itself, and clones,
  writes the files, commits, and pushes in a sandbox no agent uses.
- The clone checks out symbolic links as plain files (`core.symlinks=false`),
  so no factory write can follow a link that an earlier commit put in the
  repository.
- A commit changes only `apps/<user>/<app>/` and the root `render.yaml`.
  `commitPaths()` stages only these paths, and `pushVerified()` refuses a
  commit that changes any other path, before every push attempt. This holds
  for `publish-app` and for both pushing steps of `delete-app`.
- The root Blueprint is built from the `factory.json` of each app in the
  push's clone. `readAllSpecs()` accepts a spec only in the directory of the
  app it names, so one app's directory cannot declare another app's
  resources.
- The push is verified against the remote SHA before the factory waits on a
  deploy, so Render always builds the commit that passed verification.

**Infrastructure**

- Infrastructure is created only by committing a Blueprint, and agents
  cannot publish, because their sandbox has no clone and no token.
- The only Render write API calls are the deletes in `app/teardown.ts`, made
  only by `delete-app-resources`, a step of `delete-app`. The gateway starts
  only `delete-app`, and `removeApp()` runs that step only after a push has
  taken the app out of the root Blueprint and `wait-for-blueprint-syncs` has
  found no pending or running sync. The deletes remove only services and
  databases in the app's own project whose names start with the app's stem,
  and then the project, which Render deletes only when it is empty.

**State and concurrency**

- `runs.idempotency_key` is unique, so a retried request cannot start a
  second run.
- `claimRun()` caps concurrent runs at `factoryConfig.maxConcurrentRuns` with
  a conditional insert, serialized by a transaction-scoped Postgres advisory
  lock so two requests cannot both take the last slot.
- A delete claims every run of one app, and `claimRunApp()` claims an app
  name for a run. Both take the same per-app advisory lock. So no run builds
  an app while it is being deleted, a delete is refused while a run of the
  app is running, and no two runs build the same app at once.
- Render filesystems are ephemeral. Cross-process state goes in Postgres.

**Verification**

- Verification is workflow-owned. `verify-app` runs the same install, build,
  and pre-deploy commands the Blueprint gives Render, against a real Postgres
  in the sandbox, and `publish-app` runs only after it passes. A health
  endpoint must answer with the database unreachable, because Render calls it
  before Postgres is ready. A `dataCheckPath` must return rows, because
  nothing else proves the schema was applied and the seed loaded.
- `node_modules/` and static-site build output are not committed.
  `appGitignore()` builds each app's `.gitignore` from its manifest:
  `node_modules/`, plus each static site's publish directory below its
  `rootDir`, never the service directory itself. `verify()` writes it and
  deletes every ignored file before it builds, so it builds from the same
  files Render's fresh clone gets.
- The sandbox is terminated in a `finally` block.

## Durability

There is no step memoization. A failed run is not resumed; the caller tries
again by posting the prompt again. The gateway stores the Render task-run ID.
Whenever a caller reads a run, or the UI lists runs, the gateway checks the
task run and marks the row failed if the task failed or was canceled, so an
interrupted task cannot leave a row `running` forever. A task that succeeds
writes its result before it returns, so the gateway never reads results. Long
service, deploy, and HTTP waits heartbeat `progress`; keep those waits
bounded.

Render Workflows does not retry a failed run either: `prompt-to-app` sets
`retry: { maxRetries: 0, waitDurationMs: 0 }` instead of the default three
retries. A retry would start again at the architect with a new sandbox, and
after a push it could deploy a second app under a new name. The catch block in
`promptToApp` sets the row to `failed` before a retry would start, so
`claimRun()` would not count the retry, the gateway would not reconcile it,
and its result could overwrite a final status. Do not turn these retries on
without adding resumability.

A transient fault is not a reason to retry the whole run. Retry the one call
that failed, with a limit, as `pushVerified()` does when another run pushed
first: the clone takes the new tip, and the push's change is made again. Each
change the factory makes is derived from its inputs, so it is never merged.
Agent subtasks keep the default retries: the parent waits for each one, so
the row stays `running` and inside the concurrency limit.

`verify-app` and `publish-app` set `maxRetries: 0`, so a failure fails the
run. A retry of `publish-app` after its push would find nothing to commit, and
the run would end as if the push changed no files. A retry of `verify-app`
after a timeout would run every build again, and a service that the failed
attempt started could still answer on the port of the next boot.

The service and deploy waits, the Blueprint lookup, and the
`wait-for-blueprint-syncs` step read Render through `retryRead()` in
`app/render.ts`. It retries a failed read after the poll interval, and fails
after five failures in a row with the last error. It fails at once on a 401 or
403, because retrying cannot fix the API key. Because `findBlueprint()` uses
it, only a lookup that completes and finds no Blueprint produces
`awaiting_blueprint`. `fetchDeployLogs()` uses it too, but if its reads cannot
finish it returns no logs instead of failing the run, because the logs are
only diagnostic. Workflow code reads Render over REST, which returns typed
records; only the agents use the Render MCP server.

If you add resumability, `ctx.step()` from Render Workflows' Durability 2.0
API is the place to start. Do not build a checkpoint store here.

`delete-app` and each of its four steps set `maxRetries: 0`. A failed step
fails the delete. A failed delete marks the app's runs `delete_failed`, and
the next `DELETE` starts the task again at the first step. Each step reads the
state an earlier attempt left, so a new attempt does only what is left. A
successful delete removes the rows. The gateway reconciles a `deleting` row
against the delete task in the same way as a `running` row.

Do not give the delete steps the default retries. A retry of
`remove-app-from-blueprint` after its push would find nothing to commit, so
the next step would not wait for the push event. A retry of
`wait-for-blueprint-syncs` would give a sync more time than
`SYNC_TIMEOUT_MS`.

## Add an agent

1. Add it to `app/agents.ts`. `id`, `model`, and `prompt` are required. `id`
   is also the registered task name, so keep it unique and stable. Give it
   `tools` only if it needs the sandbox, and `renderTools` only from
   `RENDER_READ_ONLY_TOOLS`.
2. Wrap it with `agentTask()` at the bottom of `app/agents.ts`, beside the
   other registrations.
3. Call it from the stage that needs it, in `app/workflow.ts` or a stage
   module such as `app/build.ts`, with `tasks.run(<agent>Task, input)`.
   `tasks` is the `TaskContext` that Render Workflows passes to
   `prompt-to-app`; pass it down to the stage. A task definition is not a
   function, so calling it directly does not compile. Pass
   `sandboxId: sandbox.id` and `workDir: appDir` only when the agent declares
   tools; `runClaude()` refuses tools without both.
4. If it returns JSON, add a schema to `app/contracts.ts`, register it in
   `OUTPUT_SCHEMAS`, and call the agent through `agentJson()`, which retries
   once and then fails closed.
5. Update `tests/agents.test.ts` for tool access, and add the task name to
   `tests/host.test.ts` and `scripts/doctor.ts`.

## Add a Render primitive

1. Add the kind to `TIER_KINDS` in `app/contracts.ts`, and describe in the
   architect's prompt when to choose it.
2. Give the builder a way to declare it in `manifestSchema`. The Blueprint is
   generated from the manifest, not from the plan.
3. Emit its resource block from `serviceBlocks()` or `databaseBlocks()` in
   `app/blueprint.ts`; `projectBlock()` places it in the app's project
   environment. Wire dependent env vars declaratively with `fromDatabase` or
   `fromService`, never by reading a value back from an API. A static site is
   not on the private network, and a browser uses its values, so give it only
   public values such as `envVarKey: RENDER_EXTERNAL_HOSTNAME`, never `host`,
   `port`, or `hostport`.
4. Extend `resourceNames()` so the new resource is namespaced by user and app
   and cannot collide with another resource in the workspace.
5. Give `verify()` in `app/verify.ts` a way to exercise it before the push. A
   primitive nothing verifies is a primitive that fails in production.
6. Add assertions to `tests/blueprint.test.ts`. That suite is the contract for
   what gets deployed.
7. Make `deleteAppResources()` in `app/teardown.ts` list and delete it. A
   resource the teardown does not know about stays in the app's project, and
   Render then refuses to delete the project.

## Change a template

`templates/fullstack` is a working three-tier app that every run with a web
service starts from. It exists for the contracts a prompt cannot reliably
rediscover on every run: CORS, the API base URL built from the API's public
hostname, and an idempotent migrate-and-seed wired to `preDeployCommand`.

It lives here, not in its own repository, so it stays version-locked to the
code that deploys it and CI builds it. If you change it:

1. Keep it building. `npm ci && npm run build` in both halves is a CI job, and
   a template nobody builds quietly stops building.
2. Keep the seed non-empty and both SQL files idempotent. Verification fails
   a run whose data endpoint returns no rows.
3. Update `templateLines()` in `app/build.ts` if the manifest it implies
   changes. `tests/templates.test.ts` pins the two together, and is what
   catches the template and the prompt drifting apart.
4. Keep templates text-only. They are written into the sandbox as one
   self-extracting shell script, so a binary file will not survive.

## Change the pipeline

`app/workflow.ts` holds the two narratives, `prompt-to-app` and `delete-app`.
Keep them readable: a stage is one call there, with its detail in the stage
module. Fetch large state inside the workflow instead of passing it through a
task input, and keep repeated execution safe. A rerun that chooses an existing
app name replaces the app directory with the new build's files, on the newest
tip of the branch.

Verification and publishing are subtasks of `prompt-to-app`, as the agents
are. `verify-app` returns its failures as a result, not an error.
`publish-app` returns a `PublishResult`: the commit it pushed (or `null` when
no file changed) and `changedServices`, the services that commit gives a new
deploy. Both connect to the run's
sandbox by the `sandboxId` in their input, and the parent terminates that
sandbox. `publish-app` only reads the app's files from it; it clones,
commits, and pushes in its own sandbox and terminates that sandbox
itself. The last check in `verify-app` reads the files the way `publish-app`
does, so the builder can fix anything `publish-app` would refuse, such as a
symbolic link.

Never give a credential to a sandbox an agent uses, and never push from one.
An agent can leave a process running, or a modified `git`, waiting for the
next command that has the token.

Deployment progress distinguishes `waiting_for_services`,
`waiting_for_deploys`, and `smoke_testing`. Render reporting `live` is not the
end: the public URL, data endpoint, and CORS checks must pass before the run
becomes `deployed`. Render can take minutes to route a new hostname, and
returns 404 until then, so the first check of each public URL waits
`ROUTE_TIMEOUT_MS`, not the shorter `DATA_TIMEOUT_MS`. The storefront check
must also pass: the storefront's HTML, or a script it loads, must contain the
API's public hostname. The API checks cannot see the hostname a browser uses.

Each stage in `RUN_STAGES` has an item in the stage list of
`public/index.html`, in the same order, with a tooltip saying what the stage
does and where it runs. It also has a row in the stage table of
`public/table.html`, with the same description, a cell for its time, and its
Dashboard links. `tests/gateway.test.ts` checks both, so a new stage needs an
item and a row.

### Deploy waits

Right after a push, a service's newest deploy is still the one from before
the push. Render creates the new deploy only after the GitHub webhook and the
Blueprint sync. So every wait after a push names the deploy to ignore, through
the `after` option of `waitForDeploy()`:

- **First push.** Before the push, `run()` calls `deploysBeforePublish()`,
  which records the newest deploy of each of the app's services that already
  exists. `publish-app` returns `changedServices`, from `servicesChangedBy()`:
  the services whose directory holds a changed path, which matches each
  service's `buildFilter`. `firstWaits()` passes each changed service's
  recorded deploy as `after`. Without this, a rebuild of an existing app
  would accept the old live deploy as the result of the new commit. A service
  the commit did not change gets no new deploy, so its newest deploy is its
  result.
- **Repair rounds.** A repair round waits only for the services that failed,
  and passes each failed deploy as `after`.

A push that starts no new deploy within `DEPLOY_TIMEOUT_MS` ends the run as
`deploy_failed`. Never send such a run to the smoke checks: Render keeps the
last live deploy of a failed service, so those checks could pass on old code.
Do not call `trigger_deploy` to start a deploy either; only a commit deploys.
`tests/workflow.test.ts` tests this loop.

### Deploy repairs

When a deploy fails, the deploy manager diagnoses it from that deploy's logs,
which workflow code gives it. `fetchDeployLogs()` reads them for the deploy's
time range with no type filter, so it gets the build logs, the pre-deploy
command's output, and the new instance's logs, and nothing from an earlier
deploy. Do not add a type filter: the logs API returns pre-deploy output as
`app` logs, not `build` logs, so a `build` filter loses it. Each round reads
the deploy that failed in that round. Do not give an agent `list_logs` in
place of this read: it could read the logs of every service in the workspace,
and the factory could not redact them first.

The workflow runs the deploy manager only after Render reported a failed
deploy, and the agent returns only a JSON list of `failures`. There is no
"healthy" answer: an empty list ends the run as `deploy_failed` in
`repairDeploys()`. Only Render's deploy status and the smoke checks decide
that an app works.

A repair ships through the same path as the first build. The repaired
manifest must pass `verify-app`, and then `publish-app` rewrites
`factory.json` and both Blueprints before the commit, because Render gets the
manifest only through these files. A repair can change commands, paths, and
env wiring, but not the list from `declaredResources()`: Render does not
delete a resource that leaves the Blueprint, it cannot change a service's
runtime, and the loop watches only the services it already knows. So the
workflow fails such a repair and pushes nothing. A repair that changes no
files also ends the run as `deploy_failed`.

### Resource names

Each `factory.json` records its `resourcePrefix`, which is part of every
Render resource name of the app. Read the prefix from the spec, not from
`factoryConfig`, so that a new default never renames an existing app's
resources.

## Delete an app

A delete removes an app, not just a run, because the runs of one app share
its files and resources. `removeApp()` in `app/workflow.ts` runs one subtask
per step, in this order. The steps are in `app/delete.ts`, and
`tests/workflow.test.ts` tests them:

1. `remove-app-from-blueprint`: write `deletedAt` into the app's
   `factory.json`, regenerate the root Blueprint (which leaves the app out),
   and push. Remove no source file yet: a commit that removes a service's
   files starts a build of that service, and the build fails.
2. `wait-for-blueprint-syncs`: wait a minute for the push event of the
   previous push, then until no sync of the Blueprint is pending or running.
   From step 1's commit on, the file does not declare the app, and a sync
   recreates only declared resources. So only a sync of an earlier commit can
   bring a deleted resource back.
3. `delete-app-resources`: delete the app's services, then its databases,
   then its project. Its input is only the spec fields that name them.
4. `remove-app-files`: remove the app's directory and push.

Do not change this order. A resource deleted before step 1 comes back on the
next sync. The spec holds the resource names, so if step 4 ran before step 3,
a failed delete would lose them. The files stay in the Git history.

Do not wait for the resources to leave the Blueprint's resource list. A push
that only removes resources starts no sync, and Render keeps them in that
list, so such a wait never finishes.

The two pushing steps each clone the apps repository in their own sandbox.
Their commits change only the app's directory and the root Blueprint, like
`publish-app`'s commit. Keep task inputs and results small and
JSON-serializable: they go through Render, and the Dashboard shows them on
each step's run.

Each step logs one JSON line for each thing it changes or waits for: the
commits, the unfinished syncs, and each resource it deletes or keeps. These
logs are the record of what the factory deleted, so keep them when you change
a step.

## Checklist

1. Trust boundaries between the gateway, the workflow, and the agents are
   preserved, and the [Invariants](#invariants) still hold. No credential
   goes into a sandbox an agent uses, and each commit changes only one app and
   the root Blueprint.
2. New agents are registered at the bottom of `app/agents.ts`, and task names
   match between the definition, the dispatch, `scripts/doctor.ts`, and the
   tests.
3. New external input is validated, and task inputs and results stay
   JSON-serializable.
4. Infrastructure is created through `app/blueprint.ts`, not an API call, and
   deleted only through `app/teardown.ts`.
5. Sandbox cleanup and repeated side effects are safe.
6. If configuration changed, `.env.example`, `render.yaml`,
   `scripts/doctor.ts`, `README.md`, `docs/QUICKSTART.md`, and the
   configuration table in `docs/README.md` are updated.
7. If behavior that the docs describe changed, `docs/WALKTHROUGH.md`,
   `docs/TAKEAWAYS.md`, and `docs/FAQ.md` are updated, and this file's
   invariants still match the code.
8. Browser UI changes preserve Basic Auth and never serialize secrets.
9. `npm run check` passes.
