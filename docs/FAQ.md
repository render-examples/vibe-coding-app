# FAQ for field engineering and developer relations

Talking points for running the demo live, explaining the architecture, and
answering questions about cost, safety, and how the Render products fit
together. For setup, see the [Quickstart](QUICKSTART.md); for the code tour,
see the [Walkthrough](WALKTHROUGH.md).

---

## What does this demo do?

Someone types an app idea in plain English, for example "Build a website for a
local barbershop in San Jose". The factory designs, builds, verifies, and
deploys the app on Render, and no person touches the infrastructure. The
audience watches a prompt become a live URL.

The architect agent chooses the Render primitives from the prompt. A website
gets one static site. When the prompt asks for data that users write and the
app keeps, the app also gets a Node.js API and a Postgres database.

The architecture diagram and how the Render products fit together are in the
[README](../README.md#architecture-at-a-glance).

---

## How to run it live

### Before the demo

1. **One-time setup** (already done for the shared demo workspace): the apps
   Blueprint exists in the Dashboard with Auto Sync on, and every variable is
   set on the gateway and workflow services. See the
   [Quickstart](QUICKSTART.md#4-connect-the-apps-blueprint-once).
2. **Run `npm run doctor`.** It checks the configuration, the apps
   repository, the Blueprint, the Render MCP server, Postgres, and task
   registration. It is read-only and exits non-zero when a check fails.
3. **Rehearse once.** Run your demo prompt end to end and note when each
   stage starts. Then delete that app. If the live run picks the same app
   name, it rebuilds the existing app instead of creating new resources, and
   the audience misses Render creating them.
4. **Keep a fallback.** Build one more app from a different prompt and leave
   it deployed. If the live run fails or is slow, select the fallback in the
   UI's history.
5. **Right before you go on:**
   - Sign in to the UI, so the Basic Auth dialog is not on the projector.
   - Make sure no other run is active. The cap of three runs at a time applies
     to every user of the factory.
6. **Decide how to submit:**
   - **UI:** open the gateway URL, sign in with `UI_USERNAME` and
     `UI_PASSWORD`, and type a prompt.
   - **CLI:** `npm run demo -- "Build a website for a local barbershop in San Jose"`
   - **API:** `curl -X POST -H "Authorization: Bearer $FACTORY_API_KEY" -H "Content-Type: application/json" -d '{"prompt":"..."}' $GATEWAY_URL/v1/apps`

### Choose the prompt

- **A website** gets one static site. It has the fewest steps, and Render
  deploys it seconds after the push. Example: "Build a website for a local
  barbershop in San Jose".
- **An app that keeps data** also gets an API and a Postgres database. It
  shows more of Render: a web service, Managed Postgres, `fromDatabase` and
  `fromService` wiring, the migrate-and-seed `preDeployCommand`, and the CORS
  check. It also takes longer. Name the data in the prompt, for example
  "Save the posts in a database.", and rehearse it first.
- Use a kind of business, not a real company's name. A site with a real
  company's name is a fake site for that company.

### During the demo

- The UI shows these stages: Designing, Provisioning (only for an app with a
  database), Curating, Building, Verifying, Publishing, Waiting For Services,
  Waiting For Deploys, Smoke Testing, and Done.
- Each stage has a tooltip that explains what it does and where it runs.
  Hover over it, or tab to it.
- For a talk track, click **Table view**. It shows each stage with what it
  does, where it runs, how long it took, and links to the workflow run and the
  sandbox in the Render Dashboard. The current stage is tinted and has a live
  timer. The sites table lists each URL and how long each run took.
- The builder takes the largest share of a run.
- `npm run demo` follows the status endpoint and prints the final URLs.
- If a run looks stuck, `GET /v1/apps/:runId` shows the current `stage` and
  `progress`, and `stageHistory` shows when each stage started and stopped.
- If your network drops, the run keeps going on Render. Reload the page and
  the UI shows the same run again.

### What to say at each stage

| Stage | Who does the work | Say |
| --- | --- | --- |
| Designing | `architect` agent | "The architect picks the smallest set of Render primitives for the prompt. It can look at the workspace through read-only Render MCP tools, but it cannot create anything. It writes a plan, and workflow code turns the plan into a Blueprint later." |
| Provisioning | Workflow code | "A real Postgres starts inside the sandbox, so the builder writes its schema and seed data against a real database." |
| Curating | Workflow code | "The workflow finds openly licensed photos on Wikimedia Commons and downloads them into the app. No model chooses a URL or a file name." |
| Building | `builder` agent | "The builder writes the app in a Render Sandbox. That sandbox holds only this app: no copy of the apps repository, and no GitHub token." |
| Verifying | `verify-app` task | "Workflow code builds the app from exactly the files a commit would hold, as Render will. Then it boots the app and queries its database." |
| Publishing | `publish-app` task | "A second, clean sandbox commits only this app's folder and the root Blueprint, then checks that GitHub has that exact commit." |
| Waiting For Services, Waiting For Deploys | Render | "Render's Blueprint sync creates the project and services from the committed YAML, and deploys them." |
| Smoke Testing | Workflow code | "Render says the app is live, but we are not done. The workflow tests the public URLs, the API hostname in the storefront, the data, and CORS." |
| A deploy fails | Workflow code and the `deploy-manager` agent | "Workflow code pulls the failed deploy's logs and strips secrets from them. The deploy manager diagnoses the failure from those logs, and the builder fixes it. The fix goes through the same checks and the same kind of commit." |

### After the demo

- Click **Visit live website**. It is a real app on Render, with real content.
- Open the app's project in the Render Dashboard. Its site, and its API and
  database if it has them, are grouped there.
- Show the apps repository on GitHub. Every app is a Git diff you can review.
- Show the root `render.yaml`. It is declarative infrastructure, not API
  calls.
- Point out that each app also has its own `render.yaml`, so it can graduate
  to a standalone Blueprint.
- Click **Delete app** to remove it. The app leaves the Blueprint, Render
  deletes its services, database, and project, and its files leave the apps
  repository. On stage, delete a spare app, not the one you just built.
- After the event, delete every demo app. An app with an API and a database
  keeps billing until you delete it.

---

## What does it cost to run?

These are estimates; check current Render and Anthropic pricing before quoting
them.

### Per run

| Cost | Estimate | Notes |
| --- | --- | --- |
| Anthropic API | About $1 to $5 per run | Three agents, all on Claude Sonnet. The builder uses the most, with up to 80 turns. |
| Render Sandbox | Billed with Workflows usage | One sandbox for the build, plus one per push |
| Workflow task time | Per-second billing | `prompt-to-app` and the agents run on the `standard` plan; `verify-app`, `publish-app`, and the delete tasks on `starter` |

### The factory itself

| Resource | Plan | About |
| --- | --- | --- |
| Gateway web service | Starter | $7 a month |
| Factory Postgres | basic-256mb | $7 a month |
| Workflow service | Per-task billing | Varies with use |

### Each generated app (these add up)

| Resource | Plan | About |
| --- | --- | --- |
| Static site (storefront) | Free | $0 |
| API web service | Starter | $7 a month |
| Postgres | 0.1c-256mb | $7 a month |

> **Generated apps keep running until you delete them.** Each demo of an app
> that keeps data leaves a web service and a Postgres instance running. Budget
> about $14 a month for each one, and delete them after demos with **Delete
> app** in the UI or `DELETE /v1/apps/:runId`.

### Cost controls

- `maxConcurrentRuns: 3` caps simultaneous runs, each of which uses a sandbox
  and model tokens.
- Every agent uses the `medium` model tier, `claude-sonnet-5`. The `large`
  tier, `claude-opus-5`, costs more and is unused by default. Both are set in
  `factory.config.ts`.
- Generated apps use `starter` web services and `0.1c-256mb` Postgres, the
  cheapest paid plans.

---

## Safety and trust boundaries

The canonical list of safety rules is
[Invariants in AGENTS.md](../AGENTS.md#invariants), and the
[Walkthrough](WALKTHROUGH.md#trust-boundaries-in-the-code) shows where each is
enforced. Talking points that summarize them:

- **"Agents can't create infrastructure."** The only way to create a
  resource is a Blueprint committed by workflow code. Agents have no Git
  access and no Render write tools.
- **"Model-written code runs where there is nothing to steal."** The build
  sandbox holds only the app being built, with no credentials.
- **"Permissions are code, not prompts."** Each agent's tools are an explicit
  list, checked again before every call.
- **"The model never sees raw logs."** Workflow code fetches deploy logs
  and strips secrets before the deploy manager reads them.
- **"Facts decide, models diagnose."** A failed deploy stays failed, whatever
  an agent says, and every live app is smoke-tested.

---

## Common questions

**Q: Can it build any app?**
A: Almost every app gets a static site. When the app keeps data, it also gets
a Node.js API and Postgres. The supported primitives are `static_site`,
`web_service`, and `postgres`. [AGENTS.md](../AGENTS.md#add-a-render-primitive)
shows how to add another, such as Key Value. Apps with an API start from a
Vite + React + Tailwind + Hono + node-postgres template.

**Q: What if the build fails?**
A: The builder gets the exact failure output and up to two repair rounds. If
verification still fails, the run ends as `build_failed` with the reason. In
the Render Dashboard, each verification is a `verify-app` run under the
`prompt-to-app` run, with its failures in its result.

**Q: What if the Render deploy fails?**
A: Workflow code reads the logs of each failed deploy and removes secrets. The
deploy manager diagnoses the failure from those logs and its read-only MCP
tools, and the builder fixes it, for up to two repair rounds. Each repair is
verified in the sandbox and published like the first build, and the workflow
then waits for a *new* deploy of each failed service. The run ends as
`deploy_failed` if:

- the deploy manager names no failure (a failed deploy is never treated as
  healthy),
- a repair adds or removes a service or database, or changes a service's
  kind,
- a repair changes no files, or Render starts no new deploy within 15
  minutes, or
- the repair rounds run out.

**Q: What if I submit the same idea twice?**
A: The architect may choose the same app name. Then the second run rebuilds
that app in place: it replaces the app's files, pushes, and waits for a new
deploy of each service the commit changed, not the deploy already live. Two
runs cannot build the same app at the same time; the second stops as
`failed` and asks you to resubmit.

**Q: What if a run gets stuck?**
A: Every wait has a deadline and reports progress. If a task crashes, times
out, or is canceled before it records its result, the next status poll or UI
refresh marks the run failed and frees its slot. `GET /v1/apps/:runId` always
shows the current stage. See
[Troubleshooting a stuck run](README.md#troubleshooting-a-stuck-run).

**Q: How do I delete a generated app?**
A: Select one of its runs in the UI and click **Delete app**, or send
`DELETE /v1/apps/:runId`. It removes the app with all of its runs and takes a
few minutes. If it ends as `delete_failed`, the summary says why; fix that and
delete again. Each delete step is its own run under `delete-app` in the
Dashboard. Details: [Delete an app](README.md#delete-an-app).

**Q: Can several people demo at once?**
A: Yes, up to three runs at a time across all users (configurable). Each
run gets its own sandbox, and each app its own resource names
(`vibe-<user>-<app>-web`, `-api`, `-db`). Concurrent runs push to the same
branch; a run whose push is rejected takes the new tip and makes its commit
again.

**Q: Can I build more than one app at a time?**
A: Yes. Submit the next prompt while the first run builds. The history shows
each run's stage and refreshes every 5 seconds. With three runs in progress,
the gateway refuses a new prompt and the UI explains why.

**Q: Is this safe for public or untrusted users?**
A: No. It is a demonstration: one Basic Auth user, one shared API token, no
tenant isolation, no quotas, and no abuse controls. See
[When to use this reference](README.md#when-to-use-this-reference) and
[Current limitations](README.md#current-limitations).

**Q: How is this different from just asking Claude to write code?**
A: Claude writes the code; the factory is the system around it: isolated
sandboxes, a real database during verification, declarative deployment,
log-based failure diagnosis, durable state, and a deploy-repair loop. The code
is built, migrated, booted, queried, committed, deployed, and smoke-tested
before anyone sees a URL.

**Q: Why Blueprints instead of the Render API?**
A: Three reasons. Env wiring is declarative, so `fromDatabase` and
`fromService` keep connection strings out of code. Every deploy is a Git diff.
And agents cannot create infrastructure, because the only path is a commit
they cannot make.

**Q: Does it use the Render MCP server?**
A: Yes, for the agents. The architect reads the workspace, and the deploy
manager reads service and deploy details, through ten read-only Render MCP
tools. Workflow code reads services, deploys, logs, and Blueprints over the
REST API, which returns typed records.

**Q: Where do the photos come from?**
A: Wikimedia Commons, which holds only openly licensed files. Workflow code,
not a model, searches for each subject in the plan (four at most), picks a
wide, high-resolution photo, and downloads it: HTTPS only, the two Wikimedia
upload hosts only (rechecked on every redirect), images only, up to 2 MB. The
builder publishes each photo's credit line. A subject that finds nothing is
left out, so a failure means fewer photos, not a failed run.

**Q: What models does it use?**
A: Configurable in `factory.config.ts`. By default every agent uses
`claude-sonnet-5`. A `large` tier (`claude-opus-5`) is available but unused.

**Q: Does the generated app use the free tier?**
A: The static site is free. The API and database are not: free web services
spin down after 15 minutes, which looks bad in a demo, and a workspace gets
only one free Postgres. Generated apps use the `starter` web service plan and
the `0.1c-256mb` Postgres plan.

**Q: Where are the generated apps stored?**
A: In the GitHub repository named by `APPS_REPO`, under
`apps/<user>/<app>/`. Each app has its own `factory.json`, `render.yaml`,
`README.md`, and `.gitignore`, plus its source. `node_modules/` and static
build output are not committed, because Render's build recreates them.

**Q: Can I run it locally?**
A: Yes: `npm run dev:gateway` and `npm run dev:workflows` in separate
terminals. Every run still creates a real Render Sandbox and deploys real,
billable resources. Local development changes where the orchestration runs,
not what it does.

---

## Key files

| File | What is in it |
| --- | --- |
| `factory.config.ts` | The knobs: plans, region, models, asset hosts, concurrency cap |
| `app/workflow.ts` | The two pipelines. Start here. |
| `app/agents.ts` | Agent definitions, prompts, tool grants, model tiers |
| `app/verify.ts` | Pre-deploy verification in the sandbox |
| `app/deploy.ts` | The deploy wait, repair loop, and smoke checks |
| `app/blueprint.ts` | How manifests become `render.yaml` files |
| `app/policy.ts` | Tool-call rules, path checks, the MCP allowlist, redaction |
| `app/images.ts` | Wikimedia Commons search and the checked download |
| `app/gateway.ts` | The public API and UI authentication |
| `app/store.ts` | Run state, idempotency, concurrency, app locks |
| `scripts/doctor.ts` | The pre-flight check; run it before every demo |
| `render.yaml` | The factory's own Blueprint |

---

## Quick troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `npm run doctor` fails | Missing or wrong variables | Follow the fix that each failed check prints |
| Run ends as `awaiting_blueprint` | No Blueprint in the `RENDER_WORKSPACE_ID` workspace watches the apps repository | Create one there: New > Blueprint, the apps repository, branch `main`, path `render.yaml` |
| Run fails at `waiting_for_services` | Blueprint Auto Sync is off | Turn it on in the Blueprint's settings |
| Deploy fails with a port binding error | The generated API does not bind to `0.0.0.0:$PORT` | The repair loop usually fixes it; if not, check the template |
| CORS errors in the deployed app | The API does not send `Access-Control-Allow-Origin` | The smoke check should catch this; check the generated API code |
| The site has fewer photos than subjects | Commons found nothing, or a download failed a check | Look for `image_skipped` in the `prompt-to-app` logs |
| `too many concurrent runs` (429) | Three runs are already in progress | Wait for one to finish, or raise `maxConcurrentRuns` |
