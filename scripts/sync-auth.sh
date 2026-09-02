#!/usr/bin/env bash
# Moves the xAI credential file from this workstation to the daemon host. Moves,
# not copies: the refresh token inside rotates on every use, so a second holder
# would log the daemon out. No restart is needed — the daemon reads the file on
# every poll.
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
GRAY='\033[0;90m'
NC='\033[0m'

run() {
  printf >&2 "${GRAY}$(pwd) >${NC} "
  printf >&2 "${YELLOW}"
  printf >&2 "%q " "$@"
  printf >&2 "${NC}\n"
  if ! "$@"; then
    local exit_code=$?
    echo -e >&2 "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e >&2 "${RED}[ERROR]${NC} Command failed with exit code ${exit_code}: ${YELLOW}$1${NC}"
    echo -e >&2 "${RED}        Full command:${NC} $*"
    echo -e >&2 "${RED}        Working dir:${NC} $(pwd)"
    echo -e >&2 "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    return $exit_code
  fi
}

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Host is never hardcoded: pass it as an argument, export AI_USAGE_REMOTE, or
# put AI_USAGE_REMOTE in .env (which is not committed).
if [ -z "${AI_USAGE_REMOTE:-}" ] && [ -f "${REPO_DIR}/.env" ]; then
  AI_USAGE_REMOTE="$(grep -E '^AI_USAGE_REMOTE=' "${REPO_DIR}/.env" | tail -1 | cut -d= -f2- | tr -d "\"'")"
fi

HOST="${1:-${AI_USAGE_REMOTE:-}}"
if [ -z "${HOST}" ]; then
  echo -e "${RED}No target host.${NC} Pass it as an argument:" >&2
  echo "  npm run sync:auth -- myhost" >&2
  echo "or set AI_USAGE_REMOTE in your environment or .env" >&2
  exit 1
fi

INSTALL_DIR="${AI_USAGE_INSTALL_DIR:-/opt/ai-usage}"
SERVICE_USER="${AI_USAGE_SERVICE_USER:-ai-usage}"
LOCAL_AUTH="${AI_USAGE_AUTH_DIR:-${HOME}/.local/share/ai-usage/auth}/xai.json"
REMOTE_AUTH="${INSTALL_DIR}/auth/xai.json"
STAGING="/tmp/ai-usage-auth-sync.$$"

echo -e "${GREEN}=== Move xAI credentials → ${HOST} ===${NC}"
echo "  Local:  ${LOCAL_AUTH}"
echo "  Remote: ${HOST}:${REMOTE_AUTH}"
echo ""

if [ ! -f "${LOCAL_AUTH}" ]; then
  echo -e "${RED}No credential file at ${LOCAL_AUTH} — run 'npm run login:xai' first.${NC}"
  exit 1
fi

SYNCED_AT="$(date +%s)000"

run scp -q "${LOCAL_AUTH}" "${HOST}:${STAGING}"
run ssh "${HOST}" "sudo mkdir -p ${INSTALL_DIR}/auth \
  && sudo mv ${STAGING} ${REMOTE_AUTH} \
  && sudo chown -R ${SERVICE_USER}:${SERVICE_USER} ${INSTALL_DIR}/auth \
  && sudo chmod 700 ${INSTALL_DIR}/auth \
  && sudo chmod 600 ${REMOTE_AUTH}"

# The daemon now owns the refresh-token chain; a local copy would be dead after
# its first refresh and a trap for a later re-sync.
run rm -f "${LOCAL_AUTH}"

echo ""
echo -e "${GRAY}Waiting for the next poll (up to 2 min)...${NC}"
for _ in $(seq 1 24); do
  sleep 5
  if ssh "${HOST}" "curl -s --max-time 10 http://localhost:9199/api/providers" |
    SYNCED_AT="${SYNCED_AT}" python3 -c '
import json, os, sys
data = json.load(sys.stdin)
since = int(os.environ["SYNCED_AT"])
for p in data.get("providers", []):
    if p.get("type") != "xai":
        continue
    lf = p.get("lastFetch")
    if not lf or lf.get("fetchedAt", 0) < since:
        sys.exit(2)  # not polled since the move yet
    if lf.get("error"):
        print("  " + p["id"] + ": ERROR " + str(lf["error"])); sys.exit(1)
    plan = (" - plan " + str(lf["plan"])) if lf.get("plan") else ""
    print("  " + p["id"] + ": OK - " + str(len(lf["metrics"])) + " metric(s)" + plan)
    for m in lf["metrics"]:
        print("      " + m["name"] + " [" + str(m["window"]) + "]: used=" + str(m["used"])
              + " total=" + str(m["total"]) + " " + m["unit"])
    sys.exit(0)
print("  no provider of type xai on the daemon"); sys.exit(1)
'; then
    echo -e "${GREEN}=== xAI on ${HOST}: verified ===${NC}"
    exit 0
  else
    rc=$?
    [ "${rc}" -eq 2 ] || exit "${rc}"
  fi
done
echo -e "${RED}The daemon did not poll xAI within 2 minutes — check its journal.${NC}"
exit 1
