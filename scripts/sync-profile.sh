#!/usr/bin/env bash
# Copies the logged-in browser profile from this workstation to the daemon host,
# where the service user polls the browser-session providers with it.
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
  echo "  npm run sync:profile -- myhost" >&2
  echo "or set AI_USAGE_REMOTE in your environment or .env" >&2
  exit 1
fi

SERVICE="${AI_USAGE_SERVICE:-ai-usage}"
INSTALL_DIR="${AI_USAGE_INSTALL_DIR:-/opt/ai-usage}"
SERVICE_USER="${AI_USAGE_SERVICE_USER:-ai-usage}"
LOCAL_PROFILE="${AI_USAGE_BROWSER_DIR:-${HOME}/.local/share/ai-usage/profile}"
REMOTE_PROFILE="${INSTALL_DIR}/browser/profile"
STAGING="/tmp/ai-usage-profile-sync"

echo -e "${GREEN}=== Sync browser profile → ${HOST} ===${NC}"
echo "  Local:  ${LOCAL_PROFILE}"
echo "  Remote: ${HOST}:${REMOTE_PROFILE}"
echo ""

if [ ! -d "${LOCAL_PROFILE}" ]; then
  echo -e "${RED}No profile at ${LOCAL_PROFILE} — run 'npm run login' first.${NC}"
  exit 1
fi

# The service holds the profile open, and chromium rewrites it constantly;
# copying a live profile yields a corrupt cookie store.
run ssh "${HOST}" sudo systemctl stop "${SERVICE}"

# Singleton* are host/pid-specific lock links; copying them blocks the next launch.
run rsync -a --delete \
  --exclude 'Singleton*' \
  --exclude 'lockfile' \
  --exclude 'RunningChromeVersion' \
  "${LOCAL_PROFILE}/" "${HOST}:${STAGING}/"

run ssh "${HOST}" "sudo rm -rf ${REMOTE_PROFILE} \
  && sudo mkdir -p ${INSTALL_DIR}/browser \
  && sudo mv ${STAGING} ${REMOTE_PROFILE} \
  && sudo chown -R ${SERVICE_USER}:${SERVICE_USER} ${INSTALL_DIR}/browser \
  && sudo chmod 700 ${REMOTE_PROFILE}"

run ssh "${HOST}" sudo systemctl start "${SERVICE}"

echo ""
echo -e "${GRAY}Waiting for the first poll cycle...${NC}"
sleep 25

echo -e "${GREEN}=== Browser-session providers on ${HOST} ===${NC}"
ssh "${HOST}" "curl -s --max-time 10 http://localhost:9199/api/providers" |
  python3 -c '
import json, sys
data = json.load(sys.stdin)
bad = 0
for p in data.get("providers", []):
    if not p.get("playwright"):
        continue
    pid = p["id"]
    lf = p.get("lastFetch")
    if not lf:
        print("  " + pid + ": no poll yet"); bad += 1
    elif lf.get("error"):
        print("  " + pid + ": ERROR " + str(lf["error"])); bad += 1
    else:
        plan = (" - plan " + str(lf["plan"])) if lf.get("plan") else ""
        print("  " + pid + ": OK - " + str(len(lf["metrics"])) + " metric(s)" + plan)
        for m in lf["metrics"]:
            print("      " + m["name"] + " [" + str(m["window"]) + "]: used=" + str(m["used"])
                  + " total=" + str(m["total"]) + " " + m["unit"])
sys.exit(1 if bad else 0)
'
