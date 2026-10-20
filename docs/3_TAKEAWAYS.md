# Takeaways

This repository is a reference architecture, not a framework. The useful
parts are the boundaries and feedback loops, not the exact stack. The lessons
below describe what to carry into your own coding agent, internal platform,
or AI-assisted deployment system.

For the implementation behind each lesson, read
[2_ARCHITECTURE.md](2_ARCHITECTURE.md).

## 1. Split public control from privileged execution

The gateway authenticates, validates, records, and dispatches. A separate
workflow process holds model and repository credentials and performs risky
work.

**Apply it:** inventory credentials by process. Give an internet-facing
service only the secrets required to accept and route a request. Move model,
source-control, and infrastructure credentials to a non-public worker.

**Tradeoff:** another service and deployment boundary to operate.

In this repository: `app/server.ts`, `app/host.ts`, `app/config.ts`, and
`render.yaml`.

## 2. Treat isolation as the shell-command policy

The builder can execute arbitrary shell commands. The factory does not
pretend a command regex can make arbitrary shell safe. Instead, it runs the
builder in a disposable Sandbox containing one app and no valuable
credential.

**Apply it:** assume a capable model will eventually bypass prompt rules and
command filters. Make the execution environment safe even when that happens:
minimal files, minimal environment, bounded lifetime, explicit egress, and
cleanup in `finally`.

**Tradeoff:** provisioning latency and compute cost.

In this repository: `app/sandbox.ts`, `app/tools.ts`, and `app/policy.ts`.

## 3. Separate untrusted building from trusted publishing

The build Sandbox never receives a GitHub token. Publishing copies regular
files out as data, then commits from a fresh Sandbox no agent has touched.
The push rejects changes outside the app directory and root Blueprint.

**Apply it:** split CI or agent pipelines into an untrusted build phase and a
small trusted release phase. Pass an artifact across a narrow, validated
boundary instead of adding credentials to the build environment.

**Tradeoff:** an extra artifact format, validation step, and execution
environment.

In this repository: `app/files.ts`, `app/publish.ts`, and `app/git.ts`.

## 4. Keep capabilities in code, not prompts

Each agent receives an explicit tool set. Built-in file and shell tools are
disabled, environment forwarding is allowlisted, and a pre-tool hook checks
every call.

**Apply it:** define capabilities beside the agent in versioned code and make
permission changes reviewable. Use prompts to explain permissions, never to
enforce them.

**Tradeoff:** adding a capability requires code, tests, and usually a
deployment.

In this repository: `Agent` and `runClaude()` in `app/claude.ts`,
`app/agents.ts`, and `tests/agents.test.ts`.

## 5. Let models propose; let contracts and systems decide

Architect, builder, and deploy-manager output is schema-validated. A model
may diagnose a failed deploy, but it cannot override Render's failed status
or deterministic verification.

**Apply it:** put a typed contract after every model boundary. Give models
room to generate or diagnose, then let parsers, compilers, tests, databases,
and platform status make acceptance decisions.

**Tradeoff:** useful but schema-incompatible output fails closed.

In this repository: `app/contracts.ts`, `agentJson()` in `app/claude.ts`, and
`repairDeploys()` in `app/deploy.ts`.

## 6. Generate infrastructure from a closed manifest

The builder returns a limited manifest. Trusted code turns it into a Render
Blueprint. Agents cannot submit arbitrary YAML or directly create resources.

**Apply it:** model only the primitives your product can verify, observe,
price, and delete. Generate provider configuration from that model and keep
the resulting Git diff as the audit record.

**Tradeoff:** adding a new primitive requires work across planning,
validation, deployment, verification, and cleanup.

In this repository: `manifestSchema` in `app/contracts.ts` and
`app/blueprint.ts`.

## 7. Verify the artifact that will actually ship

Before publishing, the workflow removes ignored output, runs deployment
commands, starts services, applies migrations, and queries real data. After
deployment, it checks public routing, browser-to-API wiring, data, and CORS.

**Apply it:** test from a clean artifact with production commands. Add
post-deploy checks for integration behavior that a build and health endpoint
cannot prove.

**Tradeoff:** longer runs, additional dependencies, and more failure modes to
operate.

In this repository: `app/verify.ts` and the smoke checks in `app/deploy.ts`.

## 8. Bound repair loops and preserve their invariants

Build and deploy repairs have fixed round limits. Every repair repeats
verification and publishing. A deploy repair cannot change the resource set,
and each wait requires a deploy newer than the one that failed.

**Apply it:** define what a repair may change, cap attempts, and run the same
acceptance path after every fix. Record the prior external state so stale
success cannot be mistaken for a new result.

**Tradeoff:** some fixable runs stop and require a new request.

In this repository: `app/build.ts`, `firstWaits()` and `resourceChange()` in
`app/deploy.ts`, and `waitForDeploy()` in `app/render.ts`.

## 9. Use agents only where judgment earns its cost

Agents design the product, write code, and interpret deploy failures.
Workflow code downloads images, verifies builds, writes Blueprints, publishes
Git, waits on Render, and deletes resources.

**Apply it:** ask whether a step needs interpretation or creativity. If its
correct behavior can be expressed as bounded deterministic code, implement
and test it directly.

**Tradeoff:** deterministic paths support fewer open-ended cases.

In this repository: compare `app/agents.ts` with `app/images.ts`,
`app/verify.ts`, and `app/publish.ts`.

## 10. Make durable state explicit and reconcile it

Postgres stores run status, progress, task IDs, and app ownership. Unique keys
make requests idempotent; advisory locks protect global capacity and per-app
races. API reads reconcile rows with the workflow system when a task dies
before recording its result.

**Apply it:** model the job state machine in durable storage. Assume a worker
can vanish between the side effect and the final status write, and provide a
reconciliation path.

**Tradeoff:** more state-machine and database code than a fire-and-forget
queue.

In this repository: `app/store.ts` and `reconcileWorkflowRun()` in
`app/gateway.ts`.

## 11. Retry the smallest safe operation

Top-level workflows do not retry because they contain expensive,
non-idempotent side effects. Narrow operations do retry: Render reads and Git
pushes racing on the branch tip.

**Apply it:** classify side effects before enabling retries. Retry a read, a
conditional write, or a derived commit—not an entire agent workflow—unless
the workflow has explicit checkpoints and idempotent steps.

**Tradeoff:** without checkpointing, a failed run starts over as a new run.

In this repository: task retry settings in `app/workflow.ts`,
`retryRead()` in `app/render.ts`, and `pushVerified()` in `app/git.ts`.

## 12. Design deletion with the same care as creation

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

## 13. Put platform contracts in templates

The template captures recurring integration details—CORS, public API host
wiring, idempotent migrations—while leaving product-specific content and
behavior to the builder.

**Apply it:** template the small set of contracts models repeatedly get
wrong. Build templates in CI and keep them versioned with the orchestrator
that consumes them.

**Tradeoff:** templates narrow the supported stack and require maintenance.

In this repository: `templates/fullstack`, `app/templates.ts`, and
`tests/templates.test.ts`.

## 14. Make task boundaries useful to operators

Agents, verification, publishing, and delete steps are separate workflow
tasks with distinct inputs, outputs, timings, and logs. Run stages and
structured events expose progress without giving clients internal control.

**Apply it:** split long workflows where permissions, retries, timeouts, or
operator diagnosis differ. Keep task payloads small and assume operators can
see them.

**Tradeoff:** more task definitions and orchestration code.

In this repository: `agentTask()` in `app/agents.ts`, task definitions in
the stage modules, `RUN_STAGES` in `app/store.ts`, and the browser UI.

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
