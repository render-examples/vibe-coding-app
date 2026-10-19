# Takeaways

The patterns in this repository that are worth reusing, most important first.
Each one says why it matters, what it costs, and where to find it. For the
full tour, read the [Walkthrough](WALKTHROUGH.md).

1. **Keep the public entry point separate from privileged work.**
   The gateway authenticates, validates, records, and dispatches; it holds no
   model key and no GitHub credential. The workflows host holds those and does
   the risky work. A bug in the internet-facing service cannot leak what it
   never had. *Cost:* two services to deploy and operate.
   *Where:* `app/server.ts`, `app/host.ts`, `assertGatewayEnv()` and
   `assertWorkflowEnv()` in `app/config.ts`, `render.yaml`.

2. **Make declarative infrastructure the only write path.**
   Agents never create resources. Workflow code turns a validated manifest
   into a Blueprint, commits it, and Render's Blueprint sync creates
   everything. Every resource the factory has ever created is a reviewable Git
   diff, and env wiring (`fromDatabase`, `fromService`) means no code handles a
   connection string. *Cost:* a one-time manual Blueprint connection, and only
   modeled primitives can be deployed.
   *Where:* `rootBlueprint()` and `appBlueprint()` in `app/blueprint.ts`,
   `publish-app` in `app/publish.ts`.

3. **Grant capabilities in code, not in prompts.**
   Each agent gets an explicit tool list, Claude's built-in tools are off, and
   a `PreToolUse` hook re-checks every call: paths must stay in the app
   directory, and Render tools must be on a read-only allowlist. A prompt
   injection cannot grant a tool. *Cost:* every new capability is a code and
   test change, which is deliberate friction.
   *Where:* `app/agents.ts`, `runClaude()` in `app/claude.ts`,
   `checkToolCall()` in `app/policy.ts`, `tests/agents.test.ts`.

4. **Build where nothing is worth stealing, and publish from somewhere else.**
   The builder can run any shell command, so its sandbox holds only the app
   being built: no clone of the apps repository, no token. The sandbox, not a
   command filter, is the boundary. `publish-app` then copies the app's files
   out as data (regular files only, plain paths, a size cap) and commits from
   a second sandbox no agent has touched. The push refuses any path outside
   the app's folder and the root Blueprint, and is confirmed against the
   remote SHA. CI systems that build untrusted code and publish from a
   separate job use the same idea. *Cost:* one more sandbox per push, and the
   discipline to keep every credential out of the build sandbox.
   *Where:* `initAppDir()` in `app/git.ts`, `readAppFiles()` in
   `app/files.ts`, `inAppsClone()` and `commitAndPush()` in `app/publish.ts`,
   `pushVerified()` in `app/git.ts`.

5. **Verify against reality, before and after the deploy.**
   Before publishing, the workflow builds from exactly what a commit holds,
   migrates and queries a real Postgres, and proves the health check works
   without a database. After Render reports `live`, it checks the public URLs,
   the API hostname baked into the storefront, the data endpoint, and CORS.
   These catch integration failures that a build or a deploy status cannot.
   *Cost:* longer runs and more compute.
   *Where:* `verify()` in `app/verify.ts`, `smokeStorefront()` and
   `smokeApi()` in `app/deploy.ts`.

6. **Let facts decide outcomes; let models diagnose.**
   Agent output is validated with Zod and fails closed after one repair
   attempt. A failed Render deploy status always stands: the deploy manager
   can explain a failure, but it cannot declare a deploy healthy.
   *Cost:* an agent that is right about a false alarm still cannot rescue the
   run.
   *Where:* `agentJson()` in `app/claude.ts`, `repairDeploys()` in
   `app/deploy.ts`.

7. **Bound every repair loop, and keep its invariants fixed.**
   Build repairs and deploy repairs each have a round limit. A deploy repair
   may change commands, paths, and env vars, but not the set of resources, and
   it goes through the same verify-and-publish path as the first build. The
   wait after a push accepts only a deploy newer than the one before it, so
   old live code is never mistaken for a fix. *Cost:* some fixable failures
   end the run instead of looping.
   *Where:* `buildAndVerify()` in `app/build.ts`, `firstWaits()` and
   `resourceChange()` in `app/deploy.ts`, `waitForDeploy()` in
   `app/render.ts`.

8. **Use plain workflow code for work that needs no judgment.**
   Searching Wikimedia Commons, choosing a photo, and downloading it with
   host, type, size, and redirect checks is code, not an agent. So are
   verification and publishing. It is faster, cheaper, and testable, and a
   model never chooses a URL or a file path. *Cost:* less flexibility than an
   agent with a browsing tool.
   *Where:* `collectImages()` and `downloadImage()` in `app/images.ts`.

9. **Keep durable state in Postgres, and reconcile it with the task system.**
    One `runs` table holds status, progress, heartbeats, task-run IDs, and
    claims. A unique key makes retried requests safe; a conditional insert
    under an advisory lock enforces the concurrency cap; per-app advisory locks
    stop a build and a delete from racing. When a task dies without recording
    its result, the gateway marks the row failed after asking Render
    Workflows. *Cost:* a database and a small state machine for what could be a
    script.
    *Where:* `claimRun()`, `claimRunApp()`, `claimDelete()` in `app/store.ts`,
    `reconcileWorkflowRun()` in `app/gateway.ts`.

10. **Delete in the order the declarative system allows.**
    A Blueprint never deletes a resource, and a sync recreates any declared
    resource that is missing. So a delete first commits the app out of the
    Blueprint, waits until no earlier sync can run, deletes only resources
    named for that app in its own project, and removes the files last.
    *Cost:* a second commit and about a minute of waiting.
    *Where:* `removeApp()` in `app/workflow.ts`, `app/delete.ts`,
    `app/teardown.ts`.

11. **Make every step an observable subtask.**
    Each agent, `verify-app`, `publish-app`, and each delete step is its own
    Render Workflows task, with its own run, input, result, and logs in the
    Dashboard, and structured JSON log events. Debugging starts from "which
    step failed" instead of a single long log. *Cost:* task inputs are visible
    in the Dashboard, so they must stay small and must never carry a secret.
    *Where:* `agentTask()` in `app/agents.ts`, the `task()` definitions in
    `app/verify.ts`, `app/publish.ts`, and `app/delete.ts`.

12. **Encode contracts in templates, not whole applications.**
    The full-stack template answers what a model gets wrong most often (CORS,
    the API URL in the storefront, idempotent migrations) and leaves the
    product to the model. It lives in this repository and CI builds it, so it
    cannot drift from the code that deploys it. *Cost:* a narrower stack.
    *Where:* `templates/fullstack`, `app/templates.ts`, `templateLines()` in
    `app/build.ts`, `tests/templates.test.ts`.
