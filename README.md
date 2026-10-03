# Distributed Recovery and Operational Controls

PortfolioPilot is a teaching project: a stock portfolio manager with live news, a portfolio-aware
AI assistant (built on the Claude Agent SDK), watchlists and alerts. Each numbered prompt asks a
coding agent to build one milestone. This README explains **milestone 30**.

> Project rules live in [AGENTS.md](AGENTS.md). Current progress lives in
> [docs/project-state.md](docs/project-state.md). The detailed teaching notes for this milestone are
> in [docs/lessons/30-distributed-recovery.md](docs/lessons/30-distributed-recovery.md), and the
> design decision is [ADR 0023](docs/decisions/0023-distributed-recovery-and-operational-controls.md).

---

## 1. Purpose

### What the prompt asked for

Until now the app was always tested as **one** API server and **one** background worker. Real
deployments run several copies ("replicas") of each, and those copies get restarted, crash, or lose
their databases. Prompt 30 asked the agent to:

1. Run **two API servers and two worker processes** locally behind a **reverse proxy**, and prove
   that users receive their own events whichever server they are connected to, and that one
   conversation is never executed by two workers at the same time.
2. Add **bounded graceful shutdown**: stop accepting new work, report "not ready", let current work
   finish before a deadline, release or expire locks safely, and record a truthful "interrupted"
   result when work cannot finish.
3. Add **limits and monitoring**: per-user request and concurrency limits, a global worker limit,
   queue-depth monitoring, stuck-job detection, and an **audited** administrative recovery command
   (no unauthenticated admin dashboard).
4. **Test failures**: Redis outage, worker termination, API termination, expired event history, and
   database unavailability, then document which services keep working ("degrade") and which stop,
   and show an understandable message in the UI.

**Acceptance criteria:** no duplicate financial changes, no events delivered to the wrong user, and
no assistant answer marked "completed" when it did not complete.

### Why it matters

Software that works on one machine can fail in surprising ways when several copies run at once.
Two servers might both process the same request, a restart might cut off a half-finished answer,
or a cache outage might make the app look broken. This milestone shows how to make those failures
**safe and honest**.

### What you will learn

- How a **reverse proxy** spreads traffic across servers, and when it is (and is not) safe to retry.
- What **graceful shutdown** and **readiness** mean.
- How **leases** and **fencing** stop two workers from doing the same job.
- How **rate limits** and **concurrency limits** work across several servers.
- How to design **audited admin tools** without building a risky admin website.
- How to **inject failures** (stop Redis, stop PostgreSQL, kill processes) and check invariants.

### Key terms

| Term | Meaning |
| --- | --- |
| Replica | One running copy of a service. Here: two API replicas, two worker replicas. |
| Reverse proxy | A server that receives every browser request and forwards it to one of the replicas. |
| Readiness | A health check that answers "should this replica receive new traffic right now?" |
| Graceful shutdown / drain | Stopping a process politely: refuse new work, finish current work, then exit. |
| Lease | A time-limited claim on a job ("worker A owns run X until 12:00:30"). |
| Fencing | Rejecting writes from a worker whose lease is no longer valid. |
| Idempotency key | A unique ID sent with a request so that retrying it never creates a duplicate. |
| SSE (server-sent events) | A long-lived HTTP connection the server uses to push live updates to the browser. |
| Cursor | A bookmark in the event stream so a reconnecting browser can continue where it stopped. |
| Outbox | A database table of events waiting to be delivered to Redis, so no event is lost. |
| Audit log | A permanent record of who did what and why. |

---

## 2. Steps performed

These are the steps the agent actually performed, in order.

### Step 1 — Inspect the project and restore dependencies

The agent read `AGENTS.md`, `docs/project-state.md` and the milestone plan, then studied the
existing worker, job-lease, chat and event-streaming code. `node_modules` was missing, so it was
restored from the offline cache, and a baseline build was run:

```powershell
npm ci --ignore-scripts --offline --cache .npm-cache
npm run build
```

One important finding: live-event cursors are signed with `AUTH_SECRET`. If each replica had its own
random secret, a browser could not move between servers. The configuration now **refuses to start a
named replica (`INSTANCE_ID`) without a shared `AUTH_SECRET`**.

### Step 2 — Create dedicated test containers

Failure tests stop the database and Redis, so the agent created **separate, disposable** containers
instead of touching the shared development services:

```powershell
docker run -d --name portfolio-pilot-m30-postgres -e POSTGRES_USER=portfolio_local -e POSTGRES_PASSWORD=local_only_change_me -e POSTGRES_DB=portfolio_m30_verify -p 127.0.0.1:5547:5432 postgres:17.6-alpine
docker run -d --name portfolio-pilot-m30-redis -p 127.0.0.1:6381:6379 redis:7.4.5-alpine redis-server --appendonly no
```

### Step 3 — Configuration and shared contracts

- `packages/config/src/server.ts`: new validated settings, for example `API_SHUTDOWN_GRACE_MS`,
  `API_RATE_LIMIT_PER_MINUTE`, `AGENT_SUBMIT_RATE_LIMIT_PER_MINUTE`, `AGENT_MAX_ACTIVE_RUNS_PER_USER`,
  `AGENT_GLOBAL_CONCURRENCY`, `AGENT_WORKER_CONCURRENCY`, `WORKER_SHUTDOWN_GRACE_MS`,
  `WORKER_HEALTH_PORT`, `OPS_REPORT_INTERVAL_MS`, `STUCK_QUEUED_MS`, `STUCK_RUNNING_GRACE_MS`.
- `packages/contracts/src/index.ts`: new error codes `RATE_LIMITED` and `SERVICE_UNAVAILABLE`, and a
  readiness response schema.

### Step 4 — Database changes

A new migration, `packages/db/prisma/migrations/20261016100000_operational_controls`, adds:

- `OperatorCredential`: expiring, scoped admin tokens. Only a SHA-256 hash of each token is stored.
- `AdminAuditLog`: every admin attempt. A database **trigger** blocks `UPDATE` and `DELETE`, so the
  log is append-only.

```powershell
$env:DATABASE_URL='postgresql://portfolio_local:local_only_change_me@127.0.0.1:5547/portfolio_m30_verify'
npm run migrate:deploy --workspace=@portfolio-pilot/db
```

### Step 5 — Limits, monitoring and admin logic (`packages/db`)

- `agent-jobs.ts`: job claims now count live leases under one database lock, enforcing a
  **cluster-wide** worker limit. A new `release()` returns a claimed-but-unstarted job to the queue.
- `chat-service.ts`: run admission caps active answers **per user**, under a per-user database lock,
  so two API servers cannot both let a user exceed the cap.
- `operations.ts`: a snapshot of queue depth, outbox state and **stuck jobs** (expired lease, still
  running past the time limit, or queued too long). It contains no user IDs or message text.
- `admin.ts`: operator token checks, an audited `recoverRun` (only for stuck runs) and
  `requeueOutboxEvent`.

### Step 6 — API server changes (`apps/api`)

- `server.mjs` (new): starts Next.js through its programmatic server so the app controls shutdown.
  When it receives SIGTERM, Ctrl+C or an IPC `shutdown` message, it:
  1. marks itself **draining**, so readiness returns 503;
  2. answers new requests with a 503 that carries `x-portfolio-pilot-not-processed: draining`;
  3. closes live event streams so browsers reconnect to the other server;
  4. waits for in-flight requests until `API_SHUTDOWN_GRACE_MS`, then closes connections and exits.
- `lib/rate-limit.ts` (new): per-user one-minute counters stored in Redis and shared by all API
  servers. If Redis is down, each server uses its own in-memory counter, which is weaker but still
  limited.
- `app/api/health/ready/route.ts`: reports `ready`, `degraded` (a shared dependency is down),
  `draining` or `unavailable`.

> **Key decision:** readiness only fails while a server is draining or misconfigured. If the
> database is down for *every* server, failing readiness everywhere would remove all servers at
> once. Instead the servers stay reachable and return honest error messages.

### Step 7 — Worker changes (`apps/worker`)

- `lifecycle.ts` (new): drain timing. On shutdown the worker stops claiming jobs immediately, lets
  running answers continue, aborts them about 5 seconds before the deadline so it can still save an
  `interrupted` result, then exits. Optional `/health/live` and `/health/ready` endpoints.
- `agent.ts`: several claim loops per process, a maintenance loop (lease recovery, queue-depth logs,
  stuck-job warnings), and hand-back of unstarted jobs during shutdown.
- `index.ts`: drains on SIGTERM, SIGINT, an IPC message, or when the supervising process
  disappears. That last case prevents orphaned processes.
- `admin.ts` (new): the admin command-line tool.

### Step 8 — Reverse proxy and launch scripts (`scripts/`)

- `local-proxy.mjs`: round-robin proxy that serves the web build and forwards `/api`. It **retries
  only when a request was provably not processed**: the connection was refused, or the server
  answered "draining, not processed". If a connection breaks *after* the request was sent, it never
  retries, because the server might already have saved it.
- `distributed-local.mjs`: starts the full local topology for demos.
- `verify-distributed.mjs`: the end-to-end failure test.

### Step 9 — User interface (`apps/web`)

- `service-status.tsx` (new): a banner explaining the current service state in plain language.
- `auth.tsx`: only a real "401 Unauthorized" signs the user out. Previously a database outage made
  the session check fail, which looked like being signed out.

### Step 10 — Tests, fixes and documentation

The agent wrote tests (Step 4 of "How to run" below), ran them, fixed what failed, and wrote ADR
0023, lesson 30 and the project-state update. Problems met along the way and fixed:

- Some scripted file edits failed because files mix Windows (CRLF) and Unix line endings.
- The acceptance script first sent trades without the required `currency` field, expected HTTP 201
  instead of 200, and misread the stored event format.
- One unit test timed out because of a slow first import, and the browser test's overall timeout was
  too short on its first run.
- The existing approvals test suite keeps many answers waiting at once, which the new default
  per-user limit (2) correctly refused. That one suite now sets the limit to 50, with a comment.

---

## 3. Results achieved

### Behaviour now available

- Two API servers and two agent workers run behind one address, `http://127.0.0.1:5320`.
- A user connected to server B receives events for work submitted through server A. No user
  received another user's events.
- One conversation is never executed concurrently. Two simultaneous submissions to the same
  conversation through different servers produce one `202 Accepted` and one `409 Conflict`.
- Shutting down an API server or a worker is graceful and time-limited, and answers are never
  falsely marked completed.
- Per-user rate limits, per-user active-answer limits and a global worker limit work across servers.
- Operators have an audited command-line tool. There is no admin web page.

### Which services degrade and which stop

| Failure | Keeps working | Stops | How it recovers |
| --- | --- | --- | --- |
| Redis down | Reading data, saving trades, asking the assistant, limits (per server) | Live updates | Events wait in PostgreSQL and are delivered when Redis returns |
| PostgreSQL down | Open live connections, the page already loaded | All reads and writes (503) | Retries with the same idempotency key save once; in-flight answers become "interrupted" |
| One API server lost | The other server | Requests in progress on that server | The proxy reroutes; live streams resume from their cursor |
| One worker lost | Other workers | Its running answers | After the lease expires, the answer is marked "interrupted" and is not re-run |
| Old or trimmed event history | Saved data via a fresh snapshot | Replay from the old position | The browser receives `stream.reset` and reloads a snapshot |

### Observed test results (2026-10-03)

| Check | Result |
| --- | --- |
| `npm run typecheck`, `npm run build`, browser-boundary check | Passed |
| `npm run test` (unit tests) | 324 passed, 131 skipped (those need a live database and run separately) |
| `npm run test:proxy` | 6/6 passed |
| Operational-controls tests on real PostgreSQL with real worker processes | 11/11 passed |
| `npm run verify:distributed` (end-to-end failure scenarios) | 11/11 passed, in two runs in a row |
| Chrome browser test of the outage banners | 1/1 passed |
| Earlier database test suites, rerun after the migration | Worker 50/50, API 91/91 passed |

Facts recorded by the end-to-end run:

- Both API servers served traffic (7 requests each), and both workers executed answers.
- At most 3 jobs ran at once, with a global limit of 3.
- 40 submissions were accepted across both servers before the shared limit of 40 refused more.
- A worker killed mid-answer left the answer `failed:interrupted` after the real 30-second lease
  expired. It was not re-run.
- During the Redis outage, 11 events waited in PostgreSQL and were delivered after Redis returned.
- During the PostgreSQL outage, requests returned 503 and every process stayed alive. The same trade
  retried afterwards was saved exactly once.
- Final check: 4 trade idempotency keys produced 4 rows, there were 26 completed and 2 interrupted
  answers, and no live stream contained another user's IDs.

Example summary printed by `npm run verify:distributed`:

```text
   PASS two API replicas and two agent workers behind one origin
   PASS events reach users on either replica, and never another user
   PASS one conversation never executes concurrently; caps hold across replicas
   PASS hard API termination: streams resume on the surviving replica without gaps
   PASS graceful API drain: readiness drops, nothing is lost or duplicated, exit within the deadline
   PASS worker termination: graceful drain completes work; a killed worker leaves a truthful interruption
   PASS Redis outage: live streaming degrades, PostgreSQL stays authoritative, delivery resumes
   PASS expired or trimmed retention resets to an authoritative snapshot
   PASS database outage: requests fail honestly, in-flight work is never completed falsely, retries do not duplicate
   PASS per-user submission rate is shared by both replicas
   PASS acceptance invariants: no duplicate financial mutations, no cross-user events, no false completions
```

Example readiness response while Redis was stopped:

```json
{ "status": "degraded", "dependencies": { "postgres": "up", "redis": "down" }, "requestId": "…" }
```

Example admin command output (the token is shortened here):

```text
{"ok":true,"operator":"oncall","result":{"agentRuns":{"queued":0,"running":0,"waitingForApproval":0,"liveLeases":0,...}}}
{"ok":false,"denied":"invalid_credential","error":"Operator credential is missing, invalid, expired or revoked."}
{"ok":false,"denied":"missing_scope","error":"This credential lacks the outbox:requeue scope."}
```

What users see:

- **Redis outage:** "Live updates are paused. Everything shown comes from saved records… assistant
  answers still finish and are saved."
- **Database outage:** "Saved data is temporarily unavailable. New changes are not being accepted,
  so nothing is partially saved…" The user stays signed in. The browser test checked this through
  the 30-second session refresh.

---

## 4. How to run and verify

### Prerequisites

- Windows, macOS or Linux with **Node.js 24.21.0** and **npm 11.19.0**.
- **Docker**, for the PostgreSQL 17.6 and Redis 7.4.5 containers.
- Google **Chrome**, only for the browser test.
- No AI or market-data credentials are needed. Everything runs in mock mode.

Commands below use **PowerShell** syntax. In Bash, use `export NAME=value` instead of `$env:NAME='value'`.

### Step 1 — Install and build

```powershell
npm ci --ignore-scripts --offline --cache .npm-cache   # or: npm ci
npm run build
```

### Step 2 — Start the dedicated containers and migrate

Use the `docker run` commands from Step 2 of "Steps performed", then:

```powershell
$env:DATABASE_URL='postgresql://portfolio_local:local_only_change_me@127.0.0.1:5547/portfolio_m30_verify'
npm run migrate:deploy --workspace=@portfolio-pilot/db
```

> Only use these disposable containers. The failure tests **stop** them and **flush** Redis.

### Step 3 — Fast checks

```powershell
npm run typecheck
npm run test
npm run test:proxy
npm run check:browser-boundary
```

Expected: everything passes. Database-backed tests show as "skipped" unless their environment
variables are set.

### Step 4 — Database and worker-process tests

```powershell
$env:OPERATIONS_TEST_DATABASE_URL=$env:DATABASE_URL
node node_modules/vitest/vitest.mjs run --root apps/worker test/operations.integration.test.ts
```

Expected: `Tests 11 passed (11)`.

### Step 5 — End-to-end failure scenarios

```powershell
$env:DISTRIBUTED_TEST_DATABASE_URL=$env:DATABASE_URL
$env:DISTRIBUTED_TEST_REDIS_URL='redis://127.0.0.1:6381'
$env:DISTRIBUTED_PG_CONTAINER='portfolio-pilot-m30-postgres'
$env:DISTRIBUTED_REDIS_CONTAINER='portfolio-pilot-m30-redis'
npm run verify:distributed
```

Expected: 11 `PASS` lines and exit code 0. It takes about 2–3 minutes, because it waits for real
30-second lease expiries.

### Step 6 — Try it yourself in the browser

```powershell
$env:REDIS_URL='redis://127.0.0.1:6381'
$env:AUTH_SECRET='replace-with-any-local-secret-of-32-or-more-characters'
npm run distributed:local
```

1. Open `http://127.0.0.1:5320` and sign in as **Alice**. In a second browser profile, sign in as
   **Bob**. Ask the assistant a question in each window.
2. Run `docker stop portfolio-pilot-m30-redis`. Within about 15 seconds the "Live updates are
   paused" banner appears. Data still loads and answers are still saved; use **Refresh messages** to
   see them. Then run `docker start portfolio-pilot-m30-redis`.
3. Run `docker stop portfolio-pilot-m30-postgres`. A red "Saved data is temporarily unavailable"
   alert appears and you stay signed in. Start the container again, and the banner clears.
4. Press **Ctrl+C**. Every process drains and exits.

Optional automated browser check, with the topology from step 6 still running:

```powershell
$env:DISTRIBUTED_UI_BASE_URL='http://127.0.0.1:5320'
node node_modules/@playwright/test/cli.js test --config apps/web/playwright.config.ts apps/web/e2e/distributed-recovery.spec.ts
```

### Step 7 — Use the admin command

```powershell
$env:DATA_MODE='mock'
# Break-glass issuance: the token is printed ONCE. Only its hash is stored.
$env:ADMIN_BOOTSTRAP='issue'
npm run admin --workspace=@portfolio-pilot/worker -- issue-credential --operator oncall --scopes ops:read,runs:recover --ttl-minutes 60 --reason "Lesson 30 demo"
Remove-Item Env:ADMIN_BOOTSTRAP

$env:PORTFOLIO_ADMIN_TOKEN='<paste the printed token>'
npm run admin --workspace=@portfolio-pilot/worker -- status
npm run admin --workspace=@portfolio-pilot/worker -- recover-run --run <stuck run id> --confirm <same id> --reason "Explain why"
```

Exit codes: `0` success, `3` refused (the refusal is still audited). Revoke the token afterwards:

```powershell
$env:ADMIN_BOOTSTRAP='revoke'
npm run admin --workspace=@portfolio-pilot/worker -- revoke-credential --credential <credential id> --reason "Demo finished"
```

### Step 8 — Clean up

```powershell
docker rm -f portfolio-pilot-m30-postgres portfolio-pilot-m30-redis
```

---

## 5. Limitations and unfinished work

- **Local only.** Everything was verified on one Windows computer with local containers. Nothing was
  deployed. Kubernetes probes, shutdown timing and managed-database failover are planned for
  milestones 33–35.
- **Production must start the API with `apps/api/server.mjs`**, not `next start`. Otherwise the
  bounded drain does not happen.
- **Database outages interrupt running answers.** They are reported as interrupted (never as
  completed) and are not re-run automatically. The user must ask again.
- **During a Redis outage, rate limits are per server**, so with two servers a user can send up to
  twice the limit. Live updates pause until Redis returns.
- **Admin token issuance relies on database access.** Anyone who can write to the database can issue
  tokens. Separate database roles, and permission to only insert audit rows, are deferred to
  milestone 34. The append-only trigger does not stop a database owner from using `TRUNCATE`.
- The local proxy is a **testing tool**, not a production gateway.
- **Not tested:** live Claude, live Alpaca market data, Azure services, and network splits between
  servers.
- The new migration was also applied to older verification databases on port 5546, so they now
  include the two new tables.
- This folder is not a Git repository, so no commit was made.
