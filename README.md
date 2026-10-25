# Appscrip — Forward Deployed Engineer Assignment

## Real-Time Industrial Operations Platform

**Candidate Submission:** Sahil  
**Repository:** [https://github.com/Sahil-kumar2/appscrip-assignment](https://github.com/Sahil-kumar2/appscrip-assignment)  
**Role:** Forward Deployed Engineer (FDE)  
**Deliverables:** Production Monorepo, Architecture Specifications, Interactive Mission Control Dashboard, Traffic & Chaos Simulator, and Automated Verification Suites.

---

[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20_LTS-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Fastify](https://img.shields.io/badge/Fastify-4.x-000000?style=flat-square&logo=fastify&logoColor=white)](https://fastify.dev/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?style=flat-square&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![React](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev/)
[![TailwindCSS](https://img.shields.io/badge/TailwindCSS-3.x-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![Docker Compose](https://img.shields.io/badge/Docker-Compose-2496ED?style=flat-square&logo=docker&logoColor=white)](https://docs.docker.com/compose/)
[![Vitest](https://img.shields.io/badge/Vitest-Passing-10B981?style=flat-square&logo=vitest&logoColor=white)](https://vitest.dev/)

---

## 1. Executive Summary & Design Tenets

When architecting a solution for high-throughput, erratic edge device telemetry with unpredictable network connectivity, sudden bursts, and strict alerting mandates, my core guiding philosophy was:

> **"A smaller, highly reliable system with well-reasoned transactional invariants beats a complex distributed system whose failure modes are poorly understood."**

Rather than introducing distributed message brokers (Kafka, Redis, RabbitMQ) which incur dual-write consistency hazards, distributed Two-Phase Commits (2PC), and complex operational overhead, I engineered this platform around **PostgreSQL 16 as both the durable state store and transactional queue**:

1. **Transactional Relational Queuing**: Ingested events commit with `processing_status = 'pending'`. Background workers lease batches using `SELECT ... FOR UPDATE SKIP LOCKED` with automatic 30-second lease fencing and exponential backoff dead-lettering (`MAX_EVENT_ATTEMPTS=5`).
2. **Storage-Level Ingestion Idempotency**: At-least-once edge delivery is protected by composite primary keys `(device_id, event_id)`. Duplicates return HTTP `200` with status `'duplicate'` without re-evaluating rules or spawning duplicate incidents.
3. **Stateful Incident Deduplication**: A partial unique index on active incidents `(rule_id:device_id)` guarantees that continuous anomalous readings increment `occurrence_count` and link event history rather than triggering alert storms.
4. **Resilient Transactional Outbox**: Webhooks are captured in the same database transaction as incident creation and delivered with exponential backoff, randomized jitter, and host-level circuit-breaker protection (`CLOSED` → `OPEN` → `HALF_OPEN`).
5. **Real-Time Streaming without WebSockets**: Server-Sent Events (SSE) with `pg_notify('change_log')` provide low-latency telemetry streaming with `Last-Event-ID` sequence replay across network drops.

---

## 2. Monorepo Structure

```
├── apps/
│   ├── api/                # Fastify REST ingestion, operator endpoints, and SSE streamer
│   ├── worker/             # Background queue processor, rule engine, absence detector, outbox
│   ├── web/                # Mission Control operator dashboard (React 18 + Tailwind CSS)
│   ├── simulator/          # Industrial fleet traffic generator (bursts, anomalies, disconnections)
│   └── notification-sink/  # Webhook destination with fault-injection simulation controls
├── packages/
│   └── shared/             # Zod validation schemas, domain types, cryptography, database migrations
├── migrations/             # Plain SQL migrations (001_initial_schema.sql, 002_cap_change_log.sql)
├── tests/                  # Integration test suites verifying platform failure scenarios
├── scripts/                # Automated chaos verification scripts (Bash & PowerShell)
└── docs/                   # Architectural notes, protocol specs, failure matrix, runbooks
```

---

## 3. Quickstart & Local Evaluation

### Option 1: One-Command Startup with Docker (Recommended)

Start the entire platform (PostgreSQL 16, API Gateway, Background Worker, Simulator, Notification Sink, and Mission Control Web Console):

```bash
docker compose up --build -d
```

### Live Service Endpoints & Interfaces

| Interface / Service         | Local URL                                                      | Description & Credentials                                      |
| :-------------------------- | :------------------------------------------------------------- | :------------------------------------------------------------- |
| **Mission Control Console** | [http://localhost:5173](http://localhost:5173) _(or `:8080`)_  | Live operator dashboard with situation board & incident rail   |
| **Ingestion Gateway & API** | [http://localhost:3000](http://localhost:3000)                 | `POST /v1/events` (Ingestion) & `GET /api/*` (Operator APIs)   |
| **Cluster Readiness Probe** | [http://localhost:3000/readyz](http://localhost:3000/readyz)   | Health probe verifying DB connectivity and queue lag metrics   |
| **Prometheus Telemetry**    | [http://localhost:3000/metrics](http://localhost:3000/metrics) | Telemetry ingestion rates, queue depth, outbox buffer state    |
| **Notification Sink**       | [http://localhost:4000](http://localhost:4000)                 | Webhook receiver with chaos injection controls (`/admin/mode`) |
| **PostgreSQL 16 Core**      | `localhost:5432`                                               | User: `postgres`, Password: `postgres`, Database: `aps`        |

---

### Option 2: Running Locally (Native Node.js 20+)

```bash
# 1. Install dependencies
npm install

# 2. Build shared packages and execute migrations
npm run --workspace=@aps/shared build
export DATABASE_URL="postgres://postgres:postgres@localhost:5432/aps"
npm run migrate
npm run seed

# 3. Launch platform services in separate terminal windows
npm run --workspace=@aps/api dev
npm run --workspace=@aps/worker dev
npm run --workspace=@aps/notification-sink dev
npm run --workspace=@aps/simulator dev
npm run --workspace=@aps/web dev
```

---

## 4. Commissioned Hardware Fleet & Credentials

The seed data provisions an industrial manufacturing and logistics fleet:

- **Operator Management Token**: `Bearer operator-secret-token` (Used for `/api/*` endpoints and triage actions).
- **Commissioned Edge Fleet**:

| Device Identifier        | Location              | Description                     | Ingestion Secret Key                |
| :----------------------- | :-------------------- | :------------------------------ | :---------------------------------- |
| `edge-austin-press-01`   | `loc-facility-austin` | Austin Hydraulic Press 01       | `Bearer sec_live_austin_press_01`   |
| `edge-austin-cnc-02`     | `loc-facility-austin` | Austin Precision CNC Milling 02 | `Bearer sec_live_austin_cnc_02`     |
| `edge-berlin-chiller-01` | `loc-hub-berlin`      | Berlin Refrigeration Chiller 01 | `Bearer sec_live_berlin_chiller_01` |
| `edge-berlin-sorter-02`  | `loc-hub-berlin`      | Berlin High-Speed Sorter 02     | `Bearer sec_live_berlin_sorter_02`  |
| `edge-berlin-telecom-03` | `loc-hub-berlin`      | Berlin Logistics Gateway 03     | `Bearer sec_live_berlin_telecom_03` |
| `dev-001`                | `loc-warehouse-1`     | Legacy Verification Fixture     | `Bearer key-dev-001-secret`         |

---

## 5. Automated Chaos & Failure Verification Suite

To verify the platform's self-healing guarantees under network outages, downstream failures, and process crashes in a single automated flow:

```bash
# On Linux / macOS / Git Bash:
./scripts/demo.sh

# On Windows PowerShell:
powershell -ExecutionPolicy Bypass -File ./scripts/demo.ps1
```

### Verification Stages:

1. **Cluster Health & Readiness**: Validates `/readyz` queue lag and database ping.
2. **Industrial Fleet Ingestion**: Verifies steady-state ingestion across Austin & Berlin nodes.
3. **Downstream Sink Outage**: Switches Notification Sink to HTTP `503 Service Unavailable`, ingests a critical temperature spike (`94.8°C`), and proves the incident opens and the alert safely buffers in the transactional outbox without crashing.
4. **Outbox Recovery & Drain**: Restores sink to HTTP `200 OK`; confirms outbox drains queued alerts with idempotency keys.
5. **Worker SIGKILL Crash & Reclaim**: Kills the background worker container, transmits an event while offline, restarts the worker, and proves zero lost telemetry.
6. **Audit Report**: Outputs live metric counters, deduplicated incident counts, and delivered webhook receipts.

---

## 6. Traffic Simulator Scenarios

The simulator supports targeted chaos injection commands:

```bash
npm run scenario:spike             # Injects temperature > 80°C to verify incident deduplication
npm run scenario:burst             # High-volume burst triggering 429 backpressure + Retry-After
npm run scenario:duplicate-storm   # Sends identical event batches to verify idempotency
npm run scenario:offline-reconnect # Simulates device silence (absence incident) followed by auto-resolution
npm run scenario:malformed         # Injects malformed payloads to verify individual record rejection
npm run scenario:kill-worker       # Ingests telemetry during worker restarts to verify queue durability
```

---

## 7. Quality Gates & Test Execution

```bash
# Execute unit and integration tests across monorepo
npx vitest run

# Run TypeScript typechecks across all workspaces
npm run typecheck

# Run ESLint across monorepo
npm run lint

# Check code formatting
npx prettier --check .
```

---

## 8. Technical Architecture & Documentation Index

For complete architectural notes, design decisions, and operational runbooks, refer to [`docs/`](docs/):

- **[System Architecture & Data Flow](docs/ARCHITECTURE.md)**: Deep dive into transactional boundaries, ACID state transitions, and worker lease lifecycles.
- **[Architectural Decision Records (ADRs)](docs/DECISIONS.md)**: In-depth rationale for choosing PostgreSQL 16 over Kafka/Redis, SSE over WebSockets, and Fastify over Express.
- **[Edge Telemetry Protocol Specification](docs/PROTOCOL.md)**: Comprehensive ingestion contract, error payloads, and status specifications.
- **[Platform Resilience & Failure Modes Matrix](docs/FAILURE_MODES.md)**: Exhaustive catalog of 13 failure scenarios and automated test proofs.
- **[Production Deployment & Scaling](docs/DEPLOYMENT.md)**: Managed Cloud SQL/RDS HA configuration, connection pooling via PgBouncer, and horizontal worker scaling.
- **[SRE & Operations Runbook](docs/RUNBOOK.md)**: Diagnostic commands, Prometheus alert thresholds, and incident remediation steps.

---

**Developed & Submitted by [Sahil](https://github.com/Sahil-kumar2)**  
Appscrip — Forward Deployed Engineer Assignment
