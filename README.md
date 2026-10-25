# Appscrip — Forward Deployed Engineer Assignment

## Real-Time Device Operations Platform

**Candidate Submission:** Sahil  
**Role:** Forward Deployed Engineer (FDE)  
**Deliverables:** Production Monorepo, Architecture Specification, Interactive Mission Control Dashboard, Fault-Injection Simulator, and Automated Verification Test Suite.

---

[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20_LTS-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Fastify](https://img.shields.io/badge/Fastify-4.x-000000?style=flat-square&logo=fastify&logoColor=white)](https://fastify.dev/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?style=flat-square&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![React](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev/)
[![TailwindCSS](https://img.shields.io/badge/TailwindCSS-3.x-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![Docker Compose](https://img.shields.io/badge/Docker-Compose-2496ED?style=flat-square&logo=docker&logoColor=white)](https://docs.docker.com/compose/)
[![Tests](https://img.shields.io/badge/Vitest-100%25_Passing-10B981?style=flat-square&logo=vitest&logoColor=white)](https://vitest.dev/)

---

## Executive Summary & Engineering Philosophy

When presented with the client's problem statement — managing high-volume, erratic IoT fleet telemetry with intermittent connectivity, sudden bursts, and strict incident alert requirements — my guiding engineering philosophy was:

> **"A smaller, highly reliable solution with well-reasoned decisions beats a complicated system whose failure modes are poorly understood."**

Instead of unnecessarily introducing distributed messaging infrastructure (Kafka, Redis, RabbitMQ) which creates dual-write consistency problems, distributed transactions (2PC), and operational fragility, I engineered this entire platform around **PostgreSQL 16 as the Single Source of Truth (SSOT)**:

1. **Durable Queuing without Kafka**: Ingested events commit transactionally with `processing_status = 'pending'`. Background workers lease batches using `SELECT ... FOR UPDATE SKIP LOCKED` with automatic lease fencing and exponential backoff dead-lettering (`MAX_EVENT_ATTEMPTS=5`).
2. **Strict Ingestion Idempotency**: At-least-once ingestion is protected by composite primary keys `(device_id, event_id)`. Duplicates return HTTP `200` with status `'duplicate'` without re-evaluating rules or spawning duplicate incidents.
3. **Stateful Incident Deduplication**: A partial unique index on `(rule_id:device_id)` across active incidents guarantees that continuous anomaly readings increment `occurrence_count` and attach event history rather than triggering alert storms.
4. **Resilient Transactional Outbox**: Webhooks are captured in the same database transaction as incident creation and delivered with exponential backoff, randomized jitter, and circuit-breaker protection (`CLOSED` → `OPEN` → `HALF_OPEN`).
5. **Real-Time Streaming without WebSockets**: Server-Sent Events (SSE) with `pg_notify('change_log')` provide gapless telemetry streaming with `Last-Event-ID` sequence replay across network drops.

---

## 📑 Assignment Deliverables Index

| Deliverable                  | Description                                                                                      | Location in Repository                                                                       |
| :--------------------------- | :----------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------- |
| **1. Working Prototype**     | Full-stack monorepo: Ingestion API, Worker, Mission Control Web UI, Simulator, Notification Sink | `apps/` & `packages/`                                                                        |
| **2. Architecture Diagram**  | End-to-end component interaction, ACID boundaries, and data pipelines                            | [System Architecture](#system-architecture) & [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| **3. Architecture Notes**    | In-depth justification of design decisions, evaluated alternatives, and trade-offs               | [`docs/DECISIONS.md`](docs/DECISIONS.md)                                                     |
| **4. Ingestion Protocol**    | Batch contract, clock-skew rules, per-event outcome schemas, and replay guarantees               | [`docs/PROTOCOL.md`](docs/PROTOCOL.md)                                                       |
| **5. Failure Modes Matrix**  | 11 real-world failure scenarios mapped to platform behavior and automated test proof             | [`docs/FAILURE_MODES.md`](docs/FAILURE_MODES.md)                                             |
| **6. Production Deployment** | Managed Cloud SQL/RDS HA, PgBouncer pooling, horizontal worker scaling, and mTLS                 | [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)                                                   |
| **7. Operations Runbook**    | Diagnostic playbooks, Prometheus alerts, and incident triage runbooks                            | [`docs/RUNBOOK.md`](docs/RUNBOOK.md)                                                         |

---

## System Architecture

```
                    ┌──────────────────────────────────────────────┐
                    │          Connected Hardware Fleet            │
                    │        (IoT Devices & CLI Simulator)         │
                    └──────────────────────┬───────────────────────┘
                                           │ HTTP POST /v1/events
                                           │ (Bearer Key, Batch <= 500, Idempotent)
                                           ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│ Fastify Ingestion & API Layer (apps/api)                                         │
│  ├── Bearer Key Authentication (Constant-time SHA-256 hash comparison)           │
│  ├── EventIngestionEngine (Zod schema validation & future timestamp rejection)   │
│  ├── Sliding-Window Device Rate Limiter (Token bucket per device)                │
│  ├── Queue Backpressure Gate (HTTP 429 Too Many Requests + Retry-After)          │
│  └── SSE Stream Broadcaster (pg_notify + Last-Event-ID gapless replay)          │
└────────────────────────┬───────────────────────────────────▲─────────────────────┘
                         │ ACID Commit                       │ LISTEN / NOTIFY
                         ▼                                   │
┌────────────────────────────────────────────────────────────┴─────────────────────┐
│ PostgreSQL 16 (SSOT, Durable Queue & Event Bus)                                 │
│  ├── events (processing_status: pending | processing | done | failed)             │
│  ├── incidents (dedup_key: rule_id:device_id partial unique index)               │
│  ├── incident_history & incident_events (Immutable transition log)               │
│  ├── notification_outbox (Transactional outbox for reliable webhooks)            │
│  ├── rule_evaluations (Audit trail for explainability)                           │
│  └── change_log (Sequential bigserial event log with automated capping trigger)  │
└────────────────────────┬─────────────────────────────────────────────────────────┘
                         │ SELECT ... FOR UPDATE SKIP LOCKED (Lease Fenced)
                         ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│ Distributed Background Worker (apps/worker)                                      │
│  ├── QueueWorker: Batch lease claiming & dead-letter queueing                    │
│  ├── RuleEngine: Pure functional rule evaluation (threshold | absence | type)   │
│  ├── IncidentLifecycleService: Stateful dedup upserts & absence auto-resolution  │
│  ├── AbsenceMonitor: Distributed leader election via pg_try_advisory_lock        │
│  └── OutboxWorker: Exponential backoff + full jitter + circuit breaker           │
└────────────────────────┬─────────────────────────────────────────────────────────┘
                         │ Webhooks
                         ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│ Notification Sink (apps/notification-sink)                                       │
│  └── Operator Webhook Destination with Chaos Mode (ok | fail | slow)             │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

## Direct Assignment Requirements Coverage

### 1. Device and Event Ingestion

- **Transport**: `POST /v1/events` accepting batches up to 500 events authenticated by per-device Bearer keys (stored as SHA-256 hashes with constant-time verification).
- **Out-of-Order Handling**: Every event carries device-monotonic sequence numbers `seq` and ISO 8601 UTC timestamp `ts`. The database uses `GREATEST(last_seq, $seq)` and `GREATEST(last_event_ts, $ts)` to maintain accurate telemetry state regardless of arrival order.
- **Deduplication**: Enforced at the database storage engine via `PRIMARY KEY (device_id, event_id)`.
- **Clock Skew Protection**: Events with timestamps more than 5 minutes in the future are rejected individually into the `rejected_events` ring buffer without failing the entire batch.
- **Graceful Partial Batches**: Ingest returns HTTP `200` with per-event outcomes:  
  `[{ event_id: "...", status: "accepted" | "duplicate" | "rejected", reason?: "..." }]`.

### 2. Rules and Incident Management

- **Rule Engine**: Evaluates three core rule types:
  - `threshold`: Numeric field comparisons (`>`, `>=`, `<`, `<=`, `==`, `!=`).
  - `event_type`: Direct type matching and JSON payload pattern criteria.
  - `absence`: Heartbeat timeout tracking (`timeout_seconds`).
- **Incident Deduplication**: A partial unique index `CREATE UNIQUE INDEX idx_incidents_active_dedup ON incidents (dedup_key) WHERE status IN ('open', 'acknowledged')` guarantees that repeat triggers update `occurrence_count` and `last_event_at` rather than creating duplicate incidents.
- **Lifecycle State Machine**: Transitions: `open` → `acknowledged` → `resolved`.
- **Automatic Absence Resolution**: When an offline device resumes reporting events, the background worker automatically identifies open absence incidents and transitions them to `auto_resolved` with full audit history (`actor: 'device_resume'`).

### 3. Live Operations Dashboard (Mission Control)

- **Zero-Refresh Real-Time UI**: React 18 + Tailwind CSS operator console powered by Server-Sent Events (SSE) `GET /api/stream`.
- **Situation Board**:
  - Custom SVG **Fleet Health Ring** displaying real-time online/stale/offline ratios.
  - Tabular monospace KPI counters (events/sec, open incidents, offline devices, queue depth).
  - Location-grouped device tiles with pulsing status indicators and inline sparklines.
- **Persistent Incident Rail**: Collapsible right-hand incident feed sorted by severity (`critical` → `warning` → `info`) with one-click **Acknowledge** and **Resolve** optimistic actions.
- **Explainability Drawer**: Clicking an incident or event renders the exact **"Why did this fire?"** rule evaluation checklist matching field values against threshold conditions.
- **Offline / Stale Data Indicators**: If connection drops, widgets automatically dim and display `"STALE DATA · Offline since hh:mm:ss"`. On reconnection, a toast announces `"Caught up: N missed events replayed"`.

### 4. Reliability and Failure Handling

- **Worker Crash Resilience**: If a worker node crashes mid-batch, its lease (`locked_until`) naturally expires after 30 seconds. Another worker replica reclaims the batch with `SKIP LOCKED`.
- **Poison Event Dead-Lettering**: Events that fail processing increment `attempts`. After `MAX_EVENT_ATTEMPTS=5`, they transition to `'failed'` status and can be re-queued via `POST /api/events/requeue-failed`.
- **Downstream Outage Protection**: The transactional outbox isolates external notification failures from core incident workflows. The outbox circuit breaker trips to `OPEN` on consecutive failures, pausing webhook attempts until recovery is probed via `HALF_OPEN`.
- **Backpressure Protection**: When pending queue depth exceeds threshold (`QUEUE_BACKPRESSURE_THRESHOLD=5000`), the API returns HTTP `429 Too Many Requests` with a `Retry-After: 5` header.

### 5. Operational Readiness & Observability

- **Health Probes**:
  - `GET /healthz`: Fast HTTP 200 process liveness probe.
  - `GET /readyz`: Deep readiness check validating PostgreSQL connectivity, pending migration status, active worker queue lag, and pending outbox depth.
- **Prometheus Metrics (`GET /metrics`)**: Ingestion rate counters, queue depth gauges, circuit breaker states, and 429 backpressure counters.
- **Structured JSON Logging**: Pino logger with correlation IDs (`X-Correlation-ID`) across all request boundaries.

---

## Monorepo Layout

```
├── apps/
│   ├── api/                # Fastify REST ingestion, operator endpoints, and SSE streamer
│   ├── worker/             # Background queue processor, rule engine, absence detector, outbox
│   ├── web/                # Mission Control operator dashboard (React 18 + Tailwind CSS)
│   ├── simulator/          # Fleet traffic generator (bursts, anomalies, disconnections, storms)
│   └── notification-sink/  # Operator webhook destination with fault-injection simulation controls
├── packages/
│   └── shared/             # Zod validation schemas, domain types, cryptography, database migrations
├── migrations/             # Plain SQL migrations (001_initial_schema.sql)
├── tests/                  # Integration test suites verifying all platform failure scenarios
├── scripts/                # Automated end-to-end chaos & demonstration scripts (Bash & PowerShell)
└── docs/                   # Architectural notes, protocol specs, failure matrix, runbooks
```

---

## Quickstart & Evaluation Instructions

### Option 1: One-Command Startup with Docker (Recommended)

Start the entire platform (PostgreSQL 16, API, Worker, Simulator, Notification Sink, and Web Console):

```bash
docker compose up --build -d
```

### Web Interfaces & Live Endpoints

| Service                       | Endpoint                                                       | Purpose                                                          |
| :---------------------------- | :------------------------------------------------------------- | :--------------------------------------------------------------- |
| **Mission Control Console**   | [http://localhost:5173](http://localhost:5173) _(or `:8080`)_  | Live operator dashboard with incident rail & situation board     |
| **Ingestion & Operator API**  | [http://localhost:3000](http://localhost:3000)                 | `POST /v1/events` (Device ingest) & `GET /api/*` (Operator APIs) |
| **API Readiness & Queue Lag** | [http://localhost:3000/readyz](http://localhost:3000/readyz)   | Health probe verifying DB connectivity and queue lag metrics     |
| **Prometheus Metrics**        | [http://localhost:3000/metrics](http://localhost:3000/metrics) | Telemetry ingestion rate, queue depth, outbox state              |
| **Notification Sink**         | [http://localhost:4000](http://localhost:4000)                 | Webhook target with chaos injection controls (`/admin/mode`)     |
| **PostgreSQL Database**       | `localhost:5432`                                               | User: `postgres`, Password: `postgres`, Database: `aps`          |

---

### Option 2: Running Locally (Native Node.js)

```bash
# 1. Install dependencies
npm install

# 2. Build shared types & run migrations
npm run --workspace=@aps/shared build
export DATABASE_URL="postgres://postgres:postgres@localhost:5432/aps"
npm run migrate
npm run seed

# 3. Start services in separate terminals
npm run --workspace=@aps/api dev
npm run --workspace=@aps/worker dev
npm run --workspace=@aps/notification-sink dev
npm run --workspace=@aps/simulator dev
npm run --workspace=@aps/web dev
```

---

## Pre-Seeded Credentials & Tokens

- **Operator Token**: `Bearer operator-secret-token` (Used for all `/api/*` endpoints and dashboard actions).
- **Pre-Registered Devices**:

| Device ID | Location                                 | Ingestion Bearer Key        |
| :-------- | :--------------------------------------- | :-------------------------- |
| `dev-001` | `loc-warehouse-1` (East Coast Warehouse) | `Bearer key-dev-001-secret` |
| `dev-002` | `loc-warehouse-1` (East Coast Warehouse) | `Bearer key-dev-002-secret` |
| `dev-003` | `loc-datacenter-1` (Northern Datacenter) | `Bearer key-dev-003-secret` |
| `dev-004` | `loc-datacenter-1` (Northern Datacenter) | `Bearer key-dev-004-secret` |
| `dev-005` | `loc-datacenter-1` (Northern Datacenter) | `Bearer key-dev-005-secret` |

---

## Automated Chaos & Failure Verification

To test the system against real-world failures in an automated sequence, run the provided demonstration script:

```bash
# On Linux / macOS / Git Bash:
./scripts/demo.sh

# On Windows PowerShell:
powershell -ExecutionPolicy Bypass -File ./scripts/demo.ps1
```

The script verifies:

1. **Normal Telemetry Ingestion**: Verifies steady queue drainage.
2. **Downstream Webhook Outage**: Sets Notification Sink to HTTP `503 Service Unavailable`.
3. **Outbox Capture & Backoff**: Ingests critical temperature events (`92.5°C`), confirms incident creation, and proves webhook notifications are safely held in the outbox.
4. **Outage Recovery**: Restores Notification Sink to `200 OK` and confirms outbox retries deliver queued alerts without duplication.
5. **Worker Crash & Reclaim**: Kills the background worker container, transmits events, restarts the worker, and proves zero lost events.

---

## Simulator Traffic Scenarios

The simulator includes realistic traffic scenarios:

```bash
npm run scenario:spike             # Injects temperature > 80°C to verify incident deduplication
npm run scenario:burst             # High-volume burst triggering 429 backpressure + Retry-After
npm run scenario:duplicate-storm   # Sends identical event batches to verify idempotency
npm run scenario:offline-reconnect # Simulates device disappearance (absence incident) followed by auto-resolution
npm run scenario:malformed         # Injects malformed payloads to prove individual rejection
npm run scenario:kill-worker       # Ingestion during worker restarts to verify queue durability
```

---

## Verification & Quality Gates

```bash
# Run unit and integration tests across monorepo
npx vitest run

# Run failure scenario test suite against real PostgreSQL
npm run test:failure

# Run TypeScript typechecks across all 6 workspaces
npm run typecheck

# Run ESLint validation
npm run lint

# Check formatting
npx prettier --check .
```

---

## Architecture Decisions & Trade-Off Notes

For complete technical specifications, see the documentation in [`docs/`](docs/):

- **[Architecture & Data Flow Notes](docs/ARCHITECTURE.md)**: Deep dive into transactional boundaries, ACID state transitions, and worker lease lifecycles.
- **[Architectural Trade-Off Analysis](docs/DECISIONS.md)**: In-depth rationale for choosing PostgreSQL 16 over Kafka/Redis, SSE over WebSockets, and Fastify over Express.
- **[Protocol Contract](docs/PROTOCOL.md)**: Comprehensive ingestion protocol, error payloads, and status specifications.
- **[Failure Modes Matrix](docs/FAILURE_MODES.md)**: Exhaustive catalog of 11 failure scenarios and their automated test proofs.
- **[Production Deployment & Scaling](docs/DEPLOYMENT.md)**: Managed Cloud SQL/RDS HA configuration, connection pooling via PgBouncer, table partitioning, and horizontal worker scaling.
- **[Operations Runbook](docs/RUNBOOK.md)**: Diagnostic commands, Prometheus alert thresholds, and incident remediation steps.

---

**Developed & Submitted by [Sahil](https://github.com/Sahil-kumar2)**  
Appscrip — Forward Deployed Engineer Assignment
