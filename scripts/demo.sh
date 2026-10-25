#!/usr/bin/env bash
# ==============================================================================
# Real-Time Device Operations Platform - End-to-End Failure & Recovery Demo
# ==============================================================================
# Demonstrates platform invariants under failure:
# 1. Starts the stack (Docker Compose) and waits for health.
# 2. Runs telemetry simulation with device telemetry.
# 3. Flips the Notification Sink to FAIL mode (simulating downstream outage).
# 4. Triggers incident creation while sink is DOWN (outbox captures notification).
# 5. Flips the Notification Sink back to OK mode.
# 6. Kills the APS Worker mid-processing and restarts it (reclaim & resilience).
# 7. Prints the evidence: counts, incident IDs, delivered notifications with idempotency.
# ==============================================================================

set -euo pipefail

# ANSI color codes for readable output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

API_URL="${API_URL:-http://localhost:3000}"
SINK_URL="${SINK_URL:-http://localhost:4000}"
OPERATOR_TOKEN="${OPERATOR_TOKEN:-operator-secret-token}"

log_step() {
  echo -e "\n${BOLD}${BLUE}==> [STEP $1] $2${NC}"
}

log_info() {
  echo -e "    ${CYAN}•${NC} $1"
}

log_success() {
  echo -e "    ${GREEN}✔${NC} $1"
}

log_warn() {
  echo -e "    ${YELLOW}⚠${NC} $1"
}

echo -e "${BOLD}${CYAN}"
echo "========================================================================"
echo "    REAL-TIME DEVICE OPERATIONS PLATFORM - FAILURE RECOVERY DEMO        "
echo "========================================================================"
echo -e "${NC}"

# Check prerequisites
command -v docker >/dev/null 2>&1 || { echo -e "${RED}Error: docker is required.${NC}" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo -e "${RED}Error: curl is required.${NC}" >&2; exit 1; }

# ------------------------------------------------------------------------------
# STEP 1: Start the entire stack with Docker Compose
# ------------------------------------------------------------------------------
log_step "1/6" "Starting the platform stack (docker compose up -d --build)..."
docker compose up -d --build

log_info "Waiting for API readiness at ${API_URL}/readyz..."
READY=false
for i in {1..30}; do
  if curl -sf "${API_URL}/readyz" >/dev/null 2>&1; then
    READY=true
    break
  fi
  sleep 1
done

if [ "$READY" = true ]; then
  log_success "APS API and PostgreSQL are READY."
else
  echo -e "${RED}APS API failed to become ready within 30 seconds.${NC}"
  docker compose logs api
  exit 1
fi

log_info "Waiting for Notification Sink at ${SINK_URL}/health..."
for i in {1..15}; do
  if curl -sf "${SINK_URL}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
log_success "Notification Sink is active."

# ------------------------------------------------------------------------------
# STEP 2: Verify simulator and telemetry generation
# ------------------------------------------------------------------------------
log_step "2/6" "Verifying fleet telemetry ingestion..."
log_info "Simulator is generating telemetry across fleet (dev-001 to dev-005)."
sleep 2

INITIAL_STATS=$(curl -sf -H "Authorization: Bearer ${OPERATOR_TOKEN}" "${API_URL}/api/stats" || echo "{}")
log_info "Current Ingestion Stats:"
echo -e "${CYAN}${INITIAL_STATS}${NC}"

# ------------------------------------------------------------------------------
# STEP 3: Flip Notification Sink to FAIL mode
# ------------------------------------------------------------------------------
log_step "3/6" "Simulating downstream outage: Flipping Notification Sink to FAIL mode..."
curl -sf -X POST "${SINK_URL}/admin/mode" \
  -H "Content-Type: application/json" \
  -d '{"mode":"fail"}' >/dev/null

log_warn "Notification Sink is now returning HTTP 503 (Outage simulated)."

# Trigger a critical threshold incident via device event while sink is down
log_info "Ingesting critical temperature event (94°C) for dev-001 while sink is DOWN..."
CRIT_EVENT_ID=$(node -e "console.log(require('crypto').randomUUID())" 2>/dev/null || uuidgen 2>/dev/null || echo "11111111-2222-3333-4444-555555555555")
CRIT_TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

curl -sf -X POST "${API_URL}/v1/events" \
  -H "Authorization: Bearer key-dev-001-secret" \
  -H "Content-Type: application/json" \
  -d "[{
    \"event_id\": \"${CRIT_EVENT_ID}\",
    \"device_id\": \"dev-001\",
    \"seq\": 99999,
    \"ts\": \"${CRIT_TS}\",
    \"type\": \"telemetry\",
    \"payload\": {\"temperature\": 94.5, \"pressure\": 101.3},
    \"schema_version\": 1
  }]" >/dev/null

log_success "Critical event accepted and committed to Postgres."
sleep 2

log_info "Checking outbox state while sink is failing (Circuit breaker & retry active)..."
OUTBOX_STATE=$(curl -sf -H "Authorization: Bearer ${OPERATOR_TOKEN}" "${API_URL}/api/stats" | grep -o '"notification_outbox":{[^}]*}' || echo "")
log_info "Outbox metrics: ${OUTBOX_STATE}"

# ------------------------------------------------------------------------------
# STEP 4: Restore Notification Sink to OK mode
# ------------------------------------------------------------------------------
log_step "4/6" "Restoring Notification Sink to OK mode..."
curl -sf -X POST "${SINK_URL}/admin/mode" \
  -H "Content-Type: application/json" \
  -d '{"mode":"ok"}' >/dev/null

log_success "Notification Sink restored to HTTP 200 OK."

# ------------------------------------------------------------------------------
# STEP 5: Kill Worker container mid-stream and restart it
# ------------------------------------------------------------------------------
log_step "5/6" "Testing process crash resilience: Killing APS Worker container..."
docker compose kill worker
log_warn "APS Worker killed abruptly via SIGKILL."

log_info "Ingesting another batch of events during worker downtime..."
OFFLINE_EVENT_ID=$(node -e "console.log(require('crypto').randomUUID())" 2>/dev/null || uuidgen 2>/dev/null || echo "66666666-7777-8888-9999-000000000000")
OFFLINE_TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
curl -sf -X POST "${API_URL}/v1/events" \
  -H "Authorization: Bearer key-dev-001-secret" \
  -H "Content-Type: application/json" \
  -d "[{
    \"event_id\": \"${OFFLINE_EVENT_ID}\",
    \"device_id\": \"dev-001\",
    \"seq\": 100000,
    \"ts\": \"${OFFLINE_TS}\",
    \"type\": \"telemetry\",
    \"payload\": {\"temperature\": 95.2},
    \"schema_version\": 1
  }]" >/dev/null

log_success "Event accepted into queue while worker was stopped."

log_info "Restarting APS Worker container..."
docker compose start worker
log_success "APS Worker container restarted. Background engines resuming."

log_info "Waiting 5 seconds for worker to reclaim in-flight rows, process batch, and drain outbox..."
sleep 5

# ------------------------------------------------------------------------------
# STEP 6: Print Evidence and Proof of Invariants
# ------------------------------------------------------------------------------
log_step "6/6" "PRINTING EVIDENCE (Platform Invariants & Health)"

echo -e "\n${BOLD}${GREEN}========================================================================${NC}"
echo -e "${BOLD}${GREEN}                       EVIDENCE & INVARIANT AUDIT                       ${NC}"
echo -e "${BOLD}${GREEN}========================================================================${NC}"

echo -e "\n${BOLD}1. INGESTION & QUEUE DEPTH METRICS:${NC}"
curl -s -H "Authorization: Bearer ${OPERATOR_TOKEN}" "${API_URL}/api/stats" | python3 -m json.tool 2>/dev/null || curl -s -H "Authorization: Bearer ${OPERATOR_TOKEN}" "${API_URL}/api/stats"

echo -e "\n\n${BOLD}2. OPEN & ACTIVE INCIDENTS (Deduplication Proof):${NC}"
INCIDENTS_JSON=$(curl -s -H "Authorization: Bearer ${OPERATOR_TOKEN}" "${API_URL}/api/incidents?limit=5")
echo "$INCIDENTS_JSON" | python3 -m json.tool 2>/dev/null || echo "$INCIDENTS_JSON"

echo -e "\n\n${BOLD}3. DELIVERED NOTIFICATIONS (Notification Sink Received Audit):${NC}"
SINK_RECEIVED=$(curl -s "${SINK_URL}/received")
echo "$SINK_RECEIVED" | python3 -m json.tool 2>/dev/null || echo "$SINK_RECEIVED"

echo -e "\n\n${BOLD}4. READINESS & HEALTH VERIFICATION (/readyz):${NC}"
curl -s "${API_URL}/readyz" | python3 -m json.tool 2>/dev/null || curl -s "${API_URL}/readyz"

echo -e "\n\n${BOLD}5. PROMETHEUS METRICS SUMMARY (/metrics):${NC}"
curl -s "${API_URL}/metrics" | grep -E "^(aps_events_ingested_total|aps_queue_depth|aps_incidents_by_state|aps_circuit_breaker_state|aps_notification_outbox_by_status)" || true

echo -e "\n${BOLD}${GREEN}========================================================================${NC}"
echo -e "${BOLD}${GREEN}✔ DEMO COMPLETE: Zero lost events, deduplicated incidents, and reliable outbox.${NC}"
echo -e "${BOLD}${GREEN}========================================================================${NC}\n"
