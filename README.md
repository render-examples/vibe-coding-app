# vibe-code-demo

vibe-code-demo turns a plain-English app idea into a live, verified
application on Render. You type "Build a website for a local barbershop", and a
few minutes later you have a public URL. When the idea needs saved data, you
also get an API and a Postgres database, all wired together and smoke-tested.

It is a reference app: real, running TypeScript that shows how Render
Workflows, Sandboxes, Blueprints, Postgres, and the read-only Render MCP server
fit together in an agent product.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/render-examples/vibe-code-demo)

## Why it matters

Most "prompt to app" demos stop at generated code or a preview. Shipping
that code as a real multi-service deployment raises harder questions:

- Where does untrusted, model-written code run, and what can it reach?
- How do you keep the model away from your GitHub token and cloud API keys?
- How does an agent create infrastructure without being able to create
  *anything*?
- How do you know the deployed app works, not just that it built?

This repository answers each of those in code. Agents write and run code only
in a disposable Render Sandbox that holds no credentials. Infrastructure is
created only by committing a Render Blueprint, never by an agent calling an
API. Every app is built, migrated, booted, and queried before it is published,
and checked again at its public URL after Render deploys it.

It is written for engineers building AI app builders, coding agents, or
internal platforms on Render, and for anyone who wants a working example of
those boundaries to read and adapt. It is a demonstration, not a multi-tenant
product: see [Current limitations](docs/README.md#current-limitations).

## Architecture at a glance

```text
 User ──▶ Gateway ───────────▶ Workflows: prompt-to-app ─────▶ Sandbox
          (web service)        agents, verify, publish          (build and verify)
             │                    │             │
             └──▶ Factory DB ◀────┘             ▼
                  (Postgres)          Apps repository (GitHub)
                                                │  Blueprint auto-sync
                                                ▼
                                Deployed app (site, API, Postgres)
```

| Component | Render primitive | Role |
| --- | --- | --- |
| Gateway | Web service (Docker) | Authenticates callers, records runs, starts tasks. No model key or GitHub credential. |
| Factory DB | Managed Postgres | Run state, progress, idempotency, concurrency cap |
| Orchestrator | Workflow | Runs the agents, verification, publish, and deploy checks. Holds the model key and GitHub credential. |
| Sandbox | Sandbox | Disposable machine where the builder writes and runs code |
| Apps repository | GitHub repo | Every generated app, plus the root `render.yaml` Render watches |
| Generated app | Static site, web service, Postgres | One Render project per app, created by Blueprint sync |

## How the Render products fit together

- **Web Services** host the gateway and each generated app's API, with
  health checks and `preDeployCommand` migrations.
- **Workflows** run the pipeline as a `prompt-to-app` task whose agents and
  steps are subtasks, each with its own run and logs in the Dashboard.
- **Sandboxes** give each run an isolated machine, with a real Postgres when
  the app needs one, and no credentials.
- **Postgres** stores the factory's run state, and gives each generated app
  its own managed database.
- **Blueprints** are the only way the factory creates infrastructure: the
  workflow commits a `render.yaml`, and Render's Blueprint sync deploys it.
- **Render MCP** gives two agents read-only views of the workspace, enforced
  by an allowlist in code.

## Prerequisites

- Node.js 22 or later, and Docker (for the local Postgres)
- The [Render CLI](https://render.com/docs/cli), signed in with `render login`
- A Render workspace with Workflows and Sandboxes enabled, a Render API key,
  and the workspace ID (it starts with `tea-`)
- An Anthropic API key
- An empty GitHub repository for generated apps, connected to your Render
  account, plus a credential that can push to it: a fine-grained personal
  access token or a GitHub App, with Contents: write on that repository

## Quick start

This runs the factory on your machine. Even locally, every run creates a real
Render Sandbox and deploys real, billable services.

1. Install and configure:

   ```bash
   npm ci
   cp .env.example .env   # fill in the values; see docs/QUICKSTART.md
   ```

2. Start Postgres, which stays in the foreground, and apply the schema from
   a second terminal:

   ```bash
   npm run dev:postgres    # terminal 1
   npm run db:migrate      # terminal 2
   ```

3. Start the gateway and the workflows host:

   ```bash
   npm run dev:gateway     # terminal 2: http://localhost:3000
   npm run dev:workflows   # terminal 3: the Render CLI's local task server
   ```

4. Open `http://localhost:3000`, sign in with `UI_USERNAME` and
   `UI_PASSWORD`, and submit an idea. Or run
   `npm run demo -- "Build a website for a local barbershop"`.

5. **Connect the apps Blueprint once.** Your first run commits its app and
   ends as `awaiting_blueprint`, because nothing on Render is watching the apps
   repository yet. In the Render Dashboard, in the workspace named by
   `RENDER_WORKSPACE_ID`, choose **New > Blueprint**, pick the apps
   repository, branch `main`, Blueprint path `render.yaml`, and keep Auto Sync
   on. From then on, every run deploys when it pushes and ends as `deployed`.

Run `npm run doctor` at any point to check the wiring. It tells you which step
is missing.

Generated apps keep running, and billing, until you delete them with
**Delete app** in the UI or `DELETE /v1/apps/:runId`.

## Deploy the factory to Render

Click **Deploy to Render** above, or create a Blueprint from this repository's
`render.yaml`. It creates the gateway, the workflow service, and their database
in a `vibe-factory` project, and prompts you for the secrets. If you deploy
from a fork, first change the `repo:` field of the workflow service in
`render.yaml` to your fork's URL. [docs/QUICKSTART.md](docs/QUICKSTART.md#5-deploy-the-factory-to-render)
has the full steps.

## Documentation

- [Quickstart](docs/QUICKSTART.md): setup, first run, deploying the factory,
  cleanup, and customizing
- [Walkthrough](docs/WALKTHROUGH.md): a guided tour of the code, following one
  run end to end
- [Takeaways](docs/TAKEAWAYS.md): the reusable patterns, and where each lives
- [Operations reference](docs/README.md): configuration, troubleshooting,
  deleting apps, and limitations
- [FAQ for field engineering](docs/FAQ.md): demo talking points
- [AGENTS.md](AGENTS.md): conventions, invariants (the canonical safety
  boundaries), and checklists for contributors and coding agents

## License

MIT
