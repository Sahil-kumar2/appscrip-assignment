# 🛰️ Mission Control — Real-Time Device Operations Platform (APS)

[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20_LTS-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Fastify](https://img.shields.io/badge/Fastify-4.x-000000?style=flat-square&logo=fastify&logoColor=white)](https://fastify.dev/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?style=flat-square&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![React](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev/)
[![TailwindCSS](https://img.shields.io/badge/TailwindCSS-3.x-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![Docker Compose](https://img.shields.io/badge/Docker-Compose-2496ED?style=flat-square&logo=docker&logoColor=white)](https://docs.docker.com/compose/)
[![Tests](https://img.shields.io/badge/Tests-134_Passed-10B981?style=flat-square&logo=vitest&logoColor=white)](https://vitest.dev/)

> **A high-reliability, fault-tolerant telemetry and incident operations platform for mission-critical hardware fleets.**  
> Engineered with zero external queue dependencies — **PostgreSQL 16** serves as the transactional single source of truth, durable worker queue (`FOR UPDATE SKIP LOCKED`), and real-time event streaming bus.

---

## 📑 Table of Contents

- [Overview & Architecture](#-overview--architecture)
- [System Invariants & Guarantees](#-system-invariants--guarantees)
- [Monorepo Architecture](#-monorepo-architecture)
- [Quickstart Guide](#-quickstart-guide)
- [Live Endpoints & Interfaces](#-live-endpoints--interfaces)
- [Operator Credentials & Fleet Keys](#-operator-credentials--fleet-keys)
- [Mission Control UI Features](#-mission-control-ui-features)
- [Fault-Tolerance & Chaos Walkthrough](#-fault-tolerance--chaos-walkthrough)
- [Simulator Traffic Scenarios](#-simulator-traffic-scenarios)
- [Verification & Quality Gates](#-verification--quality-gates)
- [Technical Documentation](#-technical-documentation)

---

## 🏛️ Overview & Architecture

APS provides ingestion, real-time rule evaluation, stateful incident tracking, and reliable operator notifications for high-scale connected hardware fleets.

```
                    ┌──────────────────────────────────────────────┐
                    │          Connected Hardware Fleet            │
                    │        (IoT Devices & CLI Simulator)         │
                    └──────────────────────┬───────────────────────┘
                                           │ HTTP POST /v1/events
                                           │ (Bearer Key, Batch <= 500, Idempotent)
                                           ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│ Fastify API Layer                                                                │
│  ├── Ingestion & Payload Validation (Zod schemas, Clock-skew check)              │
│  ├── Per-event Status Reporting (accepted / duplicate / rejected)                │
│  ├── Backpressure Management (429 Too Many Requests + Retry-After)               │
│  └── SSE Change Log Streaming (pg_notify + Last-Event-ID gapless replay)         │
└────────────────────────┬───────────────────────────────────▲─────────────────────┘
                         │ ACID Ingestion                    │ LISTEN / NOTIFY
                         ▼                                   │
┌────────────────────────────────────────────────────────────┴─────────────────────┐
│ PostgreSQL 16 (Single Source of Truth & Durable Queue)                           │
│  ├── events (processing_status: pending | processing | done | failed)             │
│  ├── rule_evaluations (Audit trail & explainability)                             │
│  ├── incidents & incident_history (Deduplicated rule_id:device_id state machine) │
│  ├── notification_outbox (Atomic transactional outbox)                           │
│  └── change_log (Sequential bigserial event log)                                 │
└────────────────────────┬─────────────────────────────────────────────────────────┘
                         │ SELECT ... FOR UPDATE SKIP LOCKED (30s Lease)
                         ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│ Distributed Background Worker                                                    │
│  ├── Pure Rule Evaluation Engine (threshold | event_type | absence)              │
│  ├── Distributed Absence Leader Election (PostgreSQL Advisory Locks)             │
│  └── Outbox Notifier (Exponential Backoff + Full Jitter + Circuit Breaker)       │
└────────────────────────┬─────────────────────────────────────────────────────────┘
                         │ Webhooks
                         ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│ Notification Sink & Pager Gateways (Operator Webhook Integrations)               │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

## 🛡️ System Invariants & Guarantees

| Invariant              | Implementation Mechanism                                  | System Guarantee                                                                                                                   |
| :--------------------- | :-------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------- |
| **Durable Queuing**    | `events.processing_status` with `FOR UPDATE SKIP LOCKED`  | Zero queue loss; crashes release locks automatically after 30s lease timeout.                                                      |
| **Strict Idempotency** | Composite Unique Key `(device_id, event_id)`              | Safe at-least-once ingestion. Re-transmissions return `duplicate` without re-processing.                                           |
| **Backpressure**       | Influx rate vs pending queue lag monitoring               | When queue exceeds threshold (`QUEUE_BACKPRESSURE_THRESHOLD=5000`), returns `429` + `Retry-After: 5`.                              |
| **Incident Dedup**     | Partial unique index on open/acknowledged incidents       | Same rule + device updates the existing incident, increments occurrence count, and links event.                                    |
| **Absence Recovery**   | Global heartbeat monitoring via distributed advisory lock | When an offline device resumes reporting, absence incidents auto-resolve with full audit history.                                  |
| **Reliable Webhooks**  | Transactional Outbox pattern                              | Notifications are committed in the exact transaction that triggers incidents; retried with exponential backoff & circuit breaking. |
| **Real-Time SSE**      | `change_log` table with `Last-Event-ID` tracking          | Real-time frontend updates via SSE. Clients reconnecting catch up without missing state transitions.                               |

---

## 📦 Monorepo Architecture

Organized as an npm workspaces monorepo:

```
├── apps/
│   ├── api/                # Fastify REST ingestion, operator routes, SSE streaming, metrics
│   ├── worker/             # Background queue processor, rule engine, absence detector, outbox
│   ├── web/                # Mission Control operator dashboard (React 18 + Tailwind CSS)
│   ├── simulator/          # Fleet traffic generator (bursts, anomalies, disconnections, storms)
│   └── notification-sink/  # Operator webhook destination with fault-injection simulation controls
├── packages/
│   └── shared/             # Zod validation schemas, domain types, cryptography, database migrations
├── migrations/             # Plain SQL migrations (001_initial_schema.sql)
├── tests/                  # Integration test suites verifying all platform failure scenarios
├── scripts/                # Automated end-to-end chaos & demonstration scripts
└── docs/                   # Full system architecture, protocols, and deployment runbooks
```

---

## 🚀 Quickstart Guide

### Method 1: One-Command Startup with Docker (Recommended)

Start the entire platform (PostgreSQL, Fastify API, Worker, Simulator, Notification Sink, and Mission Control Web Console):

```bash
docker compose up --build
```

To run in background mode:

```bash
docker compose up --build -d
```

To shut down and wipe temporary database state:

```bash
docker compose down -v
```

---

### Method 2: Running Locally (Native Node.js)

#### 1. Install Dependencies

```bash
npm install
```

#### 2. Compile Shared Types & Run Migrations

```bash
npm run --workspace=@aps/shared build

# Set your local Postgres connection string
export DATABASE_URL="postgres://postgres:postgres@localhost:5432/aps"
npm run migrate
npm run seed
```

#### 3. Start Services

In separate terminal sessions:

```bash
# Terminal 1: API Server
npm run --workspace=@aps/api dev

# Terminal 2: Background Worker
npm run --workspace=@aps/worker dev

# Terminal 3: Notification Sink
npm run --workspace=@aps/notification-sink dev

# Terminal 4: Telemetry Simulator
npm run --workspace=@aps/simulator dev

# Terminal 5: Mission Control Frontend
npm run --workspace=@aps/web dev
```

---

## 🌐 Live Endpoints & Interfaces

| Component                     | Target URL                                                     | Description                                                     |
| :---------------------------- | :------------------------------------------------------------- | :-------------------------------------------------------------- |
| **Mission Control Dashboard** | [http://localhost:5173](http://localhost:5173) _(or `:8080`)_  | Full operator interface with live telemetry & incident rail     |
| **API Ingestion Service**     | [http://localhost:3000](http://localhost:3000)                 | `POST /v1/events` (Device ingestion) & `/api/*` (Operator APIs) |
| **API Liveness Probe**        | [http://localhost:3000/healthz](http://localhost:3000/healthz) | Fast HTTP `200 OK` liveness endpoint                            |
| **API Readiness & Queue Lag** | [http://localhost:3000/readyz](http://localhost:3000/readyz)   | Verifies database health and active worker queue lag            |
| **Prometheus Metrics**        | [http://localhost:3000/metrics](http://localhost:3000/metrics) | Telemetry ingestion rate, queue depth, outbox state             |
| **Notification Sink**         | [http://localhost:4000](http://localhost:4000)                 | Webhook target with chaos injection `/admin/mode`               |
| **PostgreSQL Database**       | `localhost:5432`                                               | User: `postgres`, Password: `postgres`, Database: `aps`         |

---

## 🔑 Operator Credentials & Fleet Keys

Default seeds are initialized automatically upon database migration:

### Pre-Registered Fleet Devices

| Device ID | Device Name             | Location           | Device API Ingestion Key    |
| :-------- | :---------------------- | :----------------- | :-------------------------- |
| `dev-001` | Warehouse Sensor A      | `loc-warehouse-1`  | `Bearer key-dev-001-secret` |
| `dev-002` | Warehouse Gateway B     | `loc-warehouse-1`  | `Bearer key-dev-002-secret` |
| `dev-003` | Datacenter HVAC 1       | `loc-datacenter-1` | `Bearer key-dev-003-secret` |
| `dev-004` | Datacenter Rack Monitor | `loc-datacenter-1` | `Bearer key-dev-004-secret` |
| `dev-005` | Datacenter Edge Node    | `loc-datacenter-1` | `Bearer key-dev-005-secret` |

### Operator Authentication

- **Operator Token**: `Bearer operator-secret-token` _(configurable via `OPERATOR_TOKEN`)_
- Grants access to administrative endpoints and dashboard actions.

---

## 🎛️ Mission Control UI Features

The operator web interface has been built specifically for high-density situational awareness:

- **Command Bar & Quick Switcher**: Instant global navigation (`Ctrl+K` / `⌘K`) with live connectivity pill.
- **Situation Board Overview**:
  - **Fleet Health Ring**: SVG circular gauge visualizing online, stale, and offline ratios with percentage score.
  - **Telemetry KPIs**: Monospace tabular displays of ingestion rate, open incidents, offline nodes, and queue depth.
  - **Location-Grouped Device Grid**: Compact status tiles with pulsing indicators for stale/offline states and inline sparklines.
- **Persistent Incident Rail**: Real-time right-hand rail displaying open incidents sorted by severity with color-coded severity bars and single-click **Acknowledge** & **Resolve** actions.
- **Live Monospace Telemetry Stream**: Incoming events animate with visual slide-in flashes; automatically capped to 100 rows for high-frequency rendering performance.
- **Slide-Over Incident Drawer**: Complete audit history, JSON telemetry payloads, outbox delivery logs, and a readable **"Why did this fire?"** rule evaluation checklist.
- **Connection Loss Resilience**: Live panels automatically dim and display `"STALE DATA · Offline since hh:mm:ss"`. Action buttons are safely disabled until reconnect, where an automated toast displays caught-up event count.

---

## 🔬 Fault-Tolerance & Chaos Walkthrough

Verify end-to-end resilience against real-world failures with our automated verification scripts:

### Automated Script Run

```bash
# On Linux / macOS / Git Bash:
./scripts/demo.sh

# On Windows PowerShell:
powershell -ExecutionPolicy Bypass -File ./scripts/demo.ps1
```

The script runs a 6-stage verification:

1. **Baseline Telemetry**: Confirms healthy fleet ingestion and queue processing.
2. **Downstream Webhook Outage**: Sets notification sink to HTTP `503 Service Unavailable`.
3. **Critical Threshold Trigger**: Ingests critical temperature events (`92.5°C`).
4. **Outbox Retries & Circuit Breaking**: Demonstrates backoff attempts while the sink is down.
5. **Downstream Recovery**: Restores notification sink to `200 OK` and confirms queued deliveries complete.
6. **Worker Crash & Recovery**: Kills worker mid-queue, ingests events, restarts worker, and verifies zero-loss queue drain.

---

## ⚡ Simulator Traffic Scenarios

Inject realistic hardware scenarios using the built-in simulator engine:

```bash
npm run scenario:burst             # 10x event rate burst to trigger backpressure (429 + Retry-After)
npm run scenario:spike             # Temperature anomaly to verify incident deduplication
npm run scenario:duplicate-storm   # Repeated transmission of identical events to verify idempotency
npm run scenario:offline-reconnect # Device disappearance (absence incident) followed by auto-resolution
npm run scenario:malformed         # Corrupted payloads & future timestamps to verify per-event rejection
npm run scenario:kill-worker       # Ingestion during worker restarts to verify queue durability
```

---

## 🧪 Verification & Quality Gates

Run all quality checks across the monorepo:

```bash
# Run unit and store tests (17 web tests + all package suites)
npx vitest run

# Run integration tests for failure scenarios against Postgres
npm run test:failure

# Run TypeScript typechecks across all 6 workspaces
npm run typecheck

# Run ESLint validation
npm run lint

# Check formatting
npx prettier --check .
```

---

## 📚 Technical Documentation

For in-depth architectural and operational specifications:

- **[Architecture Guide](docs/ARCHITECTURE.md)**: Data flows, transactional boundaries, and component roles.
- **[Protocol Specification](docs/PROTOCOL.md)**: Event schemas, HTTP codes, idempotency semantics, and error handling.
- **[Design Decisions & Trade-Offs](docs/DECISIONS.md)**: Deep dive into architectural choices (Postgres vs Kafka/Redis, SSE vs WebSockets).
- **[Failure Modes Matrix](docs/FAILURE_MODES.md)**: Exhaustive breakdown of failure modes and their automated test proofs.
- **[Production Deployment](docs/DEPLOYMENT.md)**: Cloud SQL/RDS High Availability, horizontal scaling, partition strategies, and mTLS.
- **[Operations Runbook](docs/RUNBOOK.md)**: Diagnostic commands, Prometheus alerts, and step-by-step incident response.

---

**Built by [Sahil](https://github.com/)** | High-Reliability Real-Time Device Operations Platform
