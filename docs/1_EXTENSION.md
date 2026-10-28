# Extend the factory

Start with a working deployment from [0_QUICKSTART.md](0_QUICKSTART.md).
This guide covers the supported extension points: factory configuration,
models and agents, generated infrastructure, templates, the pipeline, assets,
and the public surface.

Read [2_ARCHITECTURE.md](2_ARCHITECTURE.md) before changing the Sandbox,
publishing, or deletion boundaries. The canonical safety invariants live in
[AGENTS.md](../AGENTS.md#invariants).

## Change factory defaults

[`factory.config.ts`](../factory.config.ts) holds non-secret defaults:

- `branch`: branch pushed in the apps repository. The apps Blueprint must
  watch the same branch.
- `blueprintPath`: root Blueprint path watched by Render.
- `appsDir`: parent directory for `apps/<user>/<app>/`.
- `resourcePrefix`: prefix for generated Render resource names.
- `render.region`: region for generated services and databases.
- `render.servicePlan` and `render.databasePlan`: generated resource plans.
- `render.postgresMajorVersion`: generated Postgres version.
- `sandbox.buildEgress`: the only hosts the build Sandbox can reach, over
  HTTPS. Add a host when a generated stack downloads from somewhere other
  than the npm registry; its install fails without it.
- `assets.allowedHosts`, `maxBytes`, and `imageWidth`: image download policy.
- `maxConcurrentRuns`: global number of app builds the gateway may accept.
- `models`: concrete model ID for the `medium` and `large` tiers.

Changing `branch` or `blueprintPath` requires updating the apps Blueprint in
the Render Dashboard. Changing the generated region or plans affects new
Blueprint output and can affect existing apps on their next publish.

Each committed `factory.json` stores its `resourcePrefix`. Always read an
existing app's prefix from that spec; changing the default must not rename
resources already deployed.

Limits tied directly to one stage live beside that stage:

- agent `maxTurns` values are in [`app/agents.ts`](../app/agents.ts);
- build repair rounds are in [`app/build.ts`](../app/build.ts); and
- deploy repair rounds and wait deadlines are in
  [`app/deploy.ts`](../app/deploy.ts).

## Change models or prompts

Model tiers decouple an agent definition from a concrete model. Change the
tier mapping in `factory.config.ts`, then assign each agent a `model` tier in
`app/agents.ts`.

The default implementation uses the Claude Agent SDK and requires
`ANTHROPIC_API_KEY`. Supporting another provider is not a configuration-only
change: [`runClaude()`](../app/claude.ts) is the model boundary and would need
a new implementation with the same tool, environment, hook, structured
output, and usage-accounting guarantees.

When editing a prompt:

1. Keep permissions in code. A prompt may describe a boundary but must not be
   the only thing enforcing it.
2. Keep structured responses aligned with the Zod schema in
   [`app/contracts.ts`](../app/contracts.ts).
3. Keep task inputs small and free of secrets; Render displays task inputs in
   the Dashboard.
4. Add behavior-focused tests for any new guarantee.

## Add an agent

Add an agent only when it needs a distinct context, permission set, or
independently observable task. Deterministic work belongs in normal workflow
code.

1. Define an `Agent` in [`app/agents.ts`](../app/agents.ts) with a stable,
   unique `id`, a model tier, a prompt, and an explicit `timeoutSeconds`.
2. Grant `tools` only when the agent must act in the build Sandbox. Grant
   `renderTools` only from `RENDER_READ_ONLY_TOOLS`.
3. Register it with `agentTask()` at the bottom of `app/agents.ts`.
4. Invoke the registered task through `tasks.run(...)` from
   `app/workflow.ts` or a stage module. Pass `sandboxId` and `workDir` only
   when the agent has Sandbox tools.
5. For structured output, define a Zod schema in `app/contracts.ts`, register
   its JSON Schema in `OUTPUT_SCHEMAS`, and validate the result with
   `agentJson()`.
6. Update `tests/agents.test.ts`, `tests/host.test.ts`, and
   `scripts/doctor.ts`.

`agentTask()` definitions are Render task objects, not ordinary functions.
Always run them through the parent task's `TaskContext`.

The two existing roles illustrate opposite capability profiles:

- `architect`: read-only Render MCP, no Sandbox.
- `builder`: six scoped Sandbox tools, no Render MCP. During a deploy repair
  it also receives redacted deploy logs supplied by workflow code.

Do not grant an agent direct log access. Logs can contain secrets. The deploy
repair path fetches logs in trusted workflow code, redacts them, limits their
size, and only then places them in an agent task input.

## Add or change a Sandbox tool

The `Tool` and `ToolContext` contracts are in
[`app/tools.ts`](../app/tools.ts). A tool receives a workflow-bound Sandbox
and app working directory; the model cannot select either.

For a new tool:

1. Define and bound its Zod input schema.
2. Resolve every path with `resolveSandboxPath()`.
3. Bound output and return expected command failures as tool results.
4. Add it to `sandboxTools` only if the builder should receive it.
5. Add policy checks in [`app/policy.ts`](../app/policy.ts) when needed.
6. Test the allowed behavior and the boundary failures.

Do not try to secure arbitrary shell commands with pattern matching.
`sandbox__exec` is intentionally broad. Its security boundary is a
disposable Sandbox containing one app and no factory credential.

## Add a Render primitive

The factory deploys only static sites, Node web services, and Postgres. Adding
a primitive is an end-to-end contract change:

1. Add the planning kind to `TIER_KINDS` in `app/contracts.ts` and explain
   when the architect should choose it.
2. Extend `manifestSchema` so the builder can describe what it built.
3. Generate its Blueprint block in [`app/blueprint.ts`](../app/blueprint.ts).
4. Extend resource naming so every resource remains namespaced by user and
   app.
5. Add pre-publish verification in [`app/verify.ts`](../app/verify.ts).
6. Teach [`deleteAppResources()`](../app/teardown.ts) to list and delete it.
7. Add assertions to `tests/blueprint.test.ts` and delete-flow tests.

Keep environment wiring declarative:

- use `fromDatabase` for database connection values;
- use `fromService` with `RENDER_EXTERNAL_HOSTNAME` for a hostname embedded
  into a static site's browser bundle; and
- never put a private-network hostname into client-side code.

Do not accept free-form model-authored YAML. The model returns a validated
manifest; trusted code converts that manifest into the limited Blueprint
shape the factory supports.

## Change or add a template

[`templates/fullstack`](../templates/fullstack) is the starting point for an
app with a web service. It encodes integration contracts that prompts do not
reliably recreate: CORS, browser-visible API host wiring, and an idempotent
migration and seed command.

When changing it:

1. Build both `web/` and `api/`; CI does the same.
2. Keep migrations and seed data idempotent and keep the seed non-empty.
3. Update `templateLines()` in `app/build.ts` if the implied manifest
   changes.
4. Keep template files text-only because `materializeTemplate()` sends them
   through one self-extracting shell script.
5. Update `tests/templates.test.ts`.

To add another template:

1. Add its directory under `templates/`.
2. Decide in `run()` in `app/workflow.ts` when to select it.
3. Give the builder matching instructions and expected manifest details.
4. Add a CI build for every independently buildable part.

Templates should encode platform contracts, not the generated product. Leave
the app's content and product-specific behavior to the builder.

## Change the pipeline

[`app/workflow.ts`](../app/workflow.ts) should remain the readable narrative.
Put stage details in the stage module: build, verify, publish, deploy, or
delete.

When adding a stage:

- decide whether it needs judgment (agent task) or deterministic code;
- keep its input and result small and JSON-serializable;
- add a bounded timeout and make repeated execution safe;
- update `RUN_STAGES` and the UI's stage table when it is user-visible;
- preserve Sandbox cleanup in `finally`; and
- add a workflow test that exercises the public outcome.

Do not enable retries on `prompt-to-app`, `verify-app`, or `publish-app`
without first adding step-level durability. A blind retry can duplicate
side effects, reuse a stale process, or interpret an already-pushed commit as
"no changes."

Deploy repairs must continue through the same verify-and-publish path as the
initial build. A repair may change app code and service settings, but not the
set or runtime of resources already being watched in that loop.

## Extend verification

Verification is the acceptance boundary between model-written code and
publishing. A new feature is incomplete until the workflow can test it.

Prefer checks that reproduce deployment reality:

- start from files that a fresh Git clone would contain;
- run the same build and pre-deploy commands as the Blueprint;
- use a real dependency, such as Sandbox Postgres, where integration matters;
- prove health checks work before dependent services are available; and
- test public behavior after Render reports the deploy `live`.

Keep model review advisory. A deterministic build, deploy status, or smoke
test must make the final pass/fail decision.

## Add an external asset source

[`app/images.ts`](../app/images.ts) treats downloads as a network policy, not
just a search feature. A new source must define:

- allowed HTTPS hosts, including redirect targets;
- accepted content types;
- maximum declared and streamed size;
- a workflow-chosen destination inside the app; and
- failure behavior that cannot expose arbitrary network access.

Keep URL selection and downloading in workflow code when no judgment is
needed. Do not give the builder a general browser simply to fetch assets.

## Extend the API or UI

The gateway exposes:

- `POST /v1/apps`
- `GET /v1/apps/:runId`
- `DELETE /v1/apps/:runId`
- Basic-Auth equivalents under `/ui/apps`
- unauthenticated `/health` and `/ready`

For API changes, validate before side effects, preserve the 64 KB body cap,
and redact secret-shaped text from responses.

For UI changes:

- keep every browser route behind Basic Auth;
- never serialize `FACTORY_API_KEY` into HTML or JavaScript;
- ignore a browser-supplied `user` and use `UI_USERNAME`;
- keep Postgres as the source of truth; and
- add a row to the stage table in `public/index.html` when changing stages.

A production multi-tenant service needs real identity, authorization,
per-tenant quotas, and abuse prevention in front of `claimRun()`. User slugs
are namespaces, not a security boundary.

## Configuration by process

The gateway requires:

- `DATABASE_URL`
- `RENDER_API_KEY`
- `RENDER_WORKFLOW_SLUG`
- `FACTORY_API_KEY`
- `UI_USERNAME`
- `UI_PASSWORD` (at least 16 characters)

The workflows host requires:

- `DATABASE_URL`
- `APPS_REPO`
- `RENDER_API_KEY`
- `RENDER_WORKSPACE_ID`
- `ANTHROPIC_API_KEY`
- either `GITHUB_TOKEN` or all three `GITHUB_APP_*` values

Optional workflow settings are `RENDER_MCP_URL` and `GITHUB_API_URL`.

The demo script reads `FACTORY_GATEWAY_URL` and `FACTORY_USER`.
`PORT` configures the gateway and defaults to `3000`.

Keep model and GitHub credentials off the gateway. Keep the GitHub credential
out of every task input and every Sandbox an agent can use.

## Change checklist

Before finishing an extension:

1. Re-read the [invariants](../AGENTS.md#invariants).
2. Check that no new credential reaches the gateway, an agent task input, or
   the build Sandbox.
3. Validate new external and workflow inputs with Zod.
4. Verify that infrastructure creation still flows through
   `app/blueprint.ts`.
5. Verify that publishing still changes only one app directory and the root
   Blueprint.
6. Add deletion and verification support for each new resource type.
7. Update `.env.example`, `render.yaml`, `scripts/doctor.ts`, and these docs
   when configuration changes.
8. Run `npm run check`.
9. Run `render blueprints validate` when `render.yaml` changes.
