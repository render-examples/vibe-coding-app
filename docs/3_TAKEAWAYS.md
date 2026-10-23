# Takeaways

This repository is a reference architecture, not a framework: the boundaries
and feedback loops are worth copying, the exact stack is not. For the
implementation behind each lesson, read [2_ARCHITECTURE.md](2_ARCHITECTURE.md).

## 1. Keep credentials out of the code that runs untrusted work

The internet-facing gateway authenticates, validates, records, and dispatches;
a separate workflow process holds the model and repository credentials. The
same split repeats inside the workflow: the build Sandbox never receives a
GitHub token. Publishing copies regular files out as data, then commits from a
fresh Sandbox no agent has touched, and the push rejects changes outside the
app directory and root Blueprint.

**Apply it:** inventory credentials by process and give each one only what its
job needs. Split agent or CI pipelines into an untrusted build phase and a
small trusted release phase, and pass an artifact across a narrow, validated
boundary instead of adding credentials to the build environment.

**Tradeoff:** more services, an artifact format, and an extra execution
environment to operate.

In this repository: `app/server.ts`, `app/host.ts`, `app/config.ts`,
`app/files.ts`, `app/publish.ts`, `app/git.ts`, and `render.yaml`.

## 2. Enforce capabilities with isolation and code, not prompts or filters

The builder can run arbitrary shell commands, and no command regex can make
that safe. Instead, it runs in a disposable Sandbox that holds one app and no
valuable credential. Each agent gets an explicit tool set in code: built-in
file and shell tools are disabled, environment forwarding is allowlisted, and
a pre-tool hook keeps every path inside the app directory and every Render
tool read-only.

**Apply it:** assume a capable model will eventually bypass prompt rules and
command filters, and make the environment safe when it does: minimal files,
minimal environment, bounded lifetime, explicit egress, and cleanup in
`finally`. Define capabilities beside the agent in versioned code so
permission changes are reviewable. Use prompts to explain permissions, never
to enforce them.

**Tradeoff:** provisioning latency and compute cost, and a new capability
needs code, tests, and a deployment.

In this repository: `app/sandbox.ts`, `app/tools.ts`, `app/policy.ts`,
`Agent` and `runClaude()` in `app/claude.ts`, `app/agents.ts`, and
`tests/agents.test.ts`.

## 3. Narrow what the model can generate

Architect and builder output is schema-validated. The builder returns a
limited manifest, and trusted code turns it into a Render Blueprint, so agents
never submit arbitrary YAML or create resources directly. A template supplies
the integration details models repeatedly get wrong (CORS, public API host
wiring, idempotent migrations) and leaves product content and behavior to the
builder.

**Apply it:** put a typed contract after every model boundary. Model only the
infrastructure primitives your product can verify, observe, price, and
delete, generate provider configuration from that model, and keep the
resulting Git diff as the audit record. Template the small set of contracts
models get wrong, and build those templates in CI alongside the orchestrator
that consumes them.

**Tradeoff:** useful but schema-incompatible output fails closed, and each
new primitive or stack needs work across planning, validation, deployment,
verification, and cleanup.

In this repository: `app/contracts.ts` (including `manifestSchema`),
`agentJson()` in `app/claude.ts`, `app/blueprint.ts`, `templates/fullstack`,
`app/templates.ts`, and `tests/templates.test.ts`.

## 4. Accept only what real systems verify, and bound the repairs

No model output can end a run as `deployed`. Before publishing, the workflow
removes ignored output, runs deployment commands, starts services, applies
migrations, and queries real data. After deployment, only a new `live` deploy
status and smoke checks of public routing, browser-to-API wiring, data, and
CORS count. Build and deploy repairs have fixed round limits, and every repair
repeats verification and publishing. A deploy repair cannot change the
resource set, and each wait requires a deploy newer than the one that failed.

**Apply it:** give models room to generate and diagnose, then let compilers,
tests, databases, and platform status make the acceptance decision. Test a
clean artifact with production commands, and add post-deploy checks for
integration behavior a health endpoint can't prove. Define what a repair may
change, cap attempts, rerun the same acceptance path after every fix, and
record the prior external state so stale success can't pass for a new result.

**Tradeoff:** longer runs, more failure modes to operate, and some fixable
runs stop and need a new request.

In this repository: `app/verify.ts`, `app/build.ts`, `repairDeploys()`,
`firstWaits()`, `resourceChange()`, and the smoke checks in `app/deploy.ts`,
and `waitForDeploy()` in `app/render.ts`.

## 5. Use agents only where judgment earns its cost

Two agents design the product and write and repair the code. Workflow code
downloads images, verifies builds, fetches and redacts deploy logs, writes
Blueprints, publishes Git, waits on Render, and deletes resources. A separate
agent that only summarized deploy logs would add a model call and a schema
without adding judgment the builder lacks, so the builder reads them directly.

**Apply it:** ask whether a step needs interpretation or creativity. If its
correct behavior can be expressed as bounded deterministic code, implement
and test it directly.

**Tradeoff:** deterministic paths support fewer open-ended cases.

In this repository: compare `app/agents.ts` with `app/images.ts`,
`app/verify.ts`, and `app/publish.ts`.

## 6. Make durable state explicit, and size tasks by their side effects

Postgres stores run status, progress, task IDs, and app ownership. Unique keys
make requests idempotent, advisory locks protect global capacity and per-app
races, and API reads reconcile rows with the workflow system when a task dies
before recording its result. Agents, verification, publishing, and delete
steps are separate workflow tasks with their own inputs, outputs, timings,
and logs. Top-level workflows don't retry because they contain expensive,
non-idempotent side effects; narrow operations do, such as Render reads and
Git pushes racing on the branch tip.

**Apply it:** model the job state machine in durable storage, assume a worker
can vanish between a side effect and its status write, and provide a
reconciliation path. Split a long workflow where permissions, retries,
timeouts, or operator diagnosis differ. Retry a read, a conditional write, or
a derived commit, not a whole agent workflow, unless it has explicit
checkpoints. Keep task payloads small and assume operators can see them.

**Tradeoff:** more state-machine, orchestration, and database code than a
fire-and-forget queue, and a failed run starts over as a new run.

In this repository: `app/store.ts` (including `RUN_STAGES`),
`reconcileWorkflowRun()` in `app/gateway.ts`, task definitions and retry
settings in `app/workflow.ts` and the stage modules, `agentTask()` in
`app/agents.ts`, `retryRead()` in `app/render.ts`, and `pushVerified()` in
`app/git.ts`.

## 7. Design deletion with the same care as creation

Removing an app from a declarative file does not delete its resources, and an
older sync can recreate a resource deleted too early. The delete path first
changes desired state, waits for stale reconciliation, deletes scoped
resources, then removes source files.

**Apply it:** understand the controller semantics of your infrastructure
system. Preserve enough metadata to resume cleanup, scope deletion by
ownership, and make every step safe to rerun.

**Tradeoff:** cleanup takes multiple steps and may be slower than creation.

In this repository: `removeApp()` in `app/workflow.ts`, `app/delete.ts`, and
`app/teardown.ts`.

## What not to copy unchanged

Some choices are intentionally demo-sized:

- one Basic Auth user and one shared API token;
- one apps repository and branch;
- a global concurrency cap rather than tenant quotas;
- no step-level workflow resume;
- only three generated infrastructure primitives;
- one model provider; and
- generated resources that require explicit cleanup.

For a production service, keep the boundaries above but replace these
constraints with real identity and authorization, tenant isolation, quotas,
abuse controls, cost attribution, resumable steps, and lifecycle policies.
