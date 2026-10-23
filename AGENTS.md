# Repository guide for agents and contributors

This file applies to the whole repository. Read
[docs/2_ARCHITECTURE.md](docs/2_ARCHITECTURE.md) for how a run moves through
the code, and [docs/1_EXTENSION.md](docs/1_EXTENSION.md) for step-by-step
guides to common changes.

## What this is

`vibe-coding-app` turns one authenticated prompt into a deployed application
on Render. A caller posts a prompt; the gateway claims a run in Postgres and
starts the `prompt-to-app` workflow task. The architect agent plans the app,
the builder agent writes it in a credential-free Render Sandbox, `verify-app`
builds and boots it there, and `publish-app` commits it with a generated
Blueprint from a separate sandbox. Render's Blueprint sync deploys it, and the
workflow smoke-tests the public URLs. `delete-app` reverses this in four
restartable steps.

Two processes deploy independently:

- `app/server.ts`: the Hono gateway web service.
- `app/host.ts`: the Render Workflows host, which registers every task in one
  synchronous import pass.

## Commands

```bash
npm run check                          # Biome, tsc --noEmit, Vitest
npx vitest run tests/blueprint.test.ts # one file
render blueprints validate render.yaml # when render.yaml changes
npm run setup:apps-repo                # commit the empty root Blueprint, once
npm run doctor                         # read-only checks of a live setup
npm run demo                           # one prompt end to end
```

Environment gotchas:

- `npm run dev:gateway` sets `RENDER_USE_LOCAL_DEV=true` so the gateway
  dispatches to the local task server. Never put it in `.env`: the workflows
  host also loads `.env` and must use the real Render API.
- Keep network isolation off in the factory's environment. An isolated
  workflow cannot reach the database on the private network.
- The workflow service in `render.yaml` sets `repo:` to the upstream
  repository. A fork must change it.

## Module map

Each concern is one file under `app/`: no barrels, no path aliases, relative
imports with `.js` extensions. Imports flow one way:

```text
sandbox → tools → claude → agents → stages → workflow
```

The stages are `build`, `verify`, `publish`, `deploy`, and `delete`.
`contracts`, `policy`, `store`, and `sandbox` import nothing else in `app/`.
An import that points backwards is a design smell.

```text
factory.config.ts  Non-secret defaults: branch, plans, asset hosts, concurrency, models
app/
  server.ts, host.ts       Process entrypoints
  gateway.ts               Auth, routes, dispatch, run responses, reconciliation
  workflow.ts              The prompt-to-app and delete-app narratives
  build.ts                 Builder and verify-app rounds, the builder's message
  verify.ts                verify-app: build, boot, and query in the sandbox
  publish.ts               publish-app and every clone, commit, and push
  deploy.ts                Deploy waits, deploy repairs, smoke checks
  delete.ts                The four delete-app steps
  agents.ts, claude.ts     Agent definitions, agentTask(), runClaude(), agentJson()
  tools.ts, policy.ts      Sandbox tools, path rules, MCP allowlist, redaction
  contracts.ts             Zod schemas for API input, agent output, factory.json
  blueprint.ts             render.yaml generation: the only way to create resources
  teardown.ts              Scoped deletes: the only Render write API calls
  render.ts                Render REST reads and HTTP probes
  sandbox.ts, git.ts, files.ts, github.ts, store.ts, images.ts, templates.ts
public/            The Basic Auth UI: index.html, app.js, style.css
templates/fullstack/  Vite + React web and Hono + pg API that full-stack apps start from
scripts/           migrate, setup-apps-repo, doctor, demo
```

## Conventions

- Strict TypeScript, ESM, NodeNext. Validate external and workflow input with
  Zod before using it.
- Escape shell arguments with `shellEscape`. Use `execGitWithToken` for
  authenticated Git. Write free-form manifest values into a Blueprint with
  `yamlString`: one bad value breaks the root Blueprint for every app.
- Keep task inputs and results small, JSON-serializable, and free of secrets.
  The Render Dashboard shows them.
- Comments state constraints the code cannot show, not what the next line does.
- Tests never call live Render, GitHub, Postgres, model, or Commons APIs. Test
  behavior through public entry points, fake only the edges, and keep the
  suite near a hundred tests.

## Invariants

Do not weaken these without an explicit change to the security model.
[docs/2_ARCHITECTURE.md](docs/2_ARCHITECTURE.md#trust-boundaries) shows where
each is enforced.

1. The gateway holds no model key or GitHub credential. It authenticates
   every route, caps the body before parsing, takes the UI's namespace from
   `UI_USERNAME`, and redacts secret-shaped text from every response.
2. Agents get only the tools in their definition. `runClaude()` disables
   Claude's built-in tools, forwards only `ENV_ALLOWLIST`, and runs
   `checkToolCall()` before every call.
3. Only the builder gets sandbox tools. The architect gets only
   `RENDER_READ_ONLY_TOOLS`, which has no log tool. Deploy logs reach the
   builder only through workflow code, redacted before they are cut.
4. Every agent path resolves inside the app directory or `/tmp`. Shell
   commands are not filtered; the sandbox's contents are the boundary.
5. The build sandbox holds only the app: no clone of the apps repository and
   no credential. `sandboxId` and `workDir` come from workflow code, never a
   model.
6. `publish-app` reads the app's files as untrusted data and pushes from a
   fresh sandbox no agent used. Each commit changes only
   `apps/<user>/<app>/` and the root `render.yaml`, and the push is verified
   against the remote SHA.
7. Infrastructure is created only by committing a Blueprint generated from a
   validated manifest. Only `delete-app-resources` calls a Render write API,
   only after the app has left the Blueprint and no older sync is pending.
8. Agent output is schema-validated and fails closed. No agent can override a
   failed verification or a failed Render deploy status.
9. `prompt-to-app`, every agent task, `verify-app`, `publish-app`, and every
   delete step set `maxRetries: 0`. Retry only the narrow operation that
   failed, as `retryRead()` and `pushVerified()` do.
10. Run claims use a unique idempotency key and advisory locks, so a retried
    request cannot start a second run and no app is built and deleted at once.
11. Every sandbox is terminated in a `finally` block.

## Checklist

1. The invariants above still hold.
2. New agents and tasks are registered, and their names match in the
   definition, `tests/host.test.ts`, and `scripts/doctor.ts`.
3. A new stage is in `RUN_STAGES` and the stage table in `public/index.html`.
4. Configuration changes are reflected in `.env.example`, `render.yaml`,
   `scripts/doctor.ts`, and `docs/1_EXTENSION.md`.
5. Behavior the docs describe is updated in `docs/`.
6. `npm run check` passes.
