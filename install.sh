#!/usr/bin/env bash
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
    echo -e >&2 "${RED}[ERROR] Command failed with exit code ${exit_code}: ${YELLOW}$1${NC}"
    return $exit_code
  fi
}

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="/opt/ai-usage"
SERVICE_USER="ai-usage"
SERVICE_NAME="ai-usage"

echo -e "${GREEN}=== AI Usage Monitor Installer ===${NC}"
echo "  Source: ${REPO_DIR}"
echo "  Target: ${INSTALL_DIR}"
echo "  User:   ${SERVICE_USER}"
echo ""

# 1. Create service user
if ! id "${SERVICE_USER}" &>/dev/null; then
  run sudo useradd --system --home-dir "${INSTALL_DIR}" --shell /usr/sbin/nologin "${SERVICE_USER}"
  echo -e "${GREEN}✓ Created user ${SERVICE_USER}${NC}"
else
  echo -e "${GRAY}  User ${SERVICE_USER} already exists${NC}"
fi

# 2. Install to /opt/ai-usage
run sudo mkdir -p "${INSTALL_DIR}"
# 'browser' (logged-in profile) and '.cache' (chromium) are runtime state that
# --delete would otherwise wipe on every deploy.
run sudo rsync -a --delete \
  --exclude '.git' \
  --exclude '.env' \
  --exclude 'node_modules' \
  --exclude 'data' \
  --exclude 'browser' \
  --exclude '.cache' \
  "${REPO_DIR}/" "${INSTALL_DIR}/"

# 3. Install node dependencies
run sudo npm install --prefix "${INSTALL_DIR}" --omit=dev 2>&1 | tail -3

# 4. Copy .env from repo dir
if [ -f "${REPO_DIR}/.env" ]; then
  run sudo cp "${REPO_DIR}/.env" "${INSTALL_DIR}/.env"
  run sudo chmod 600 "${INSTALL_DIR}/.env"
  echo -e "${GREEN}✓ Copied .env${NC}"
else
  echo -e "${YELLOW}⚠ No .env found in ${REPO_DIR} — create one before starting the service${NC}"
fi

# 5. Create data and browser-profile directories
run sudo mkdir -p "${INSTALL_DIR}/data" "${INSTALL_DIR}/browser"

# 6. Set ownership
run sudo chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}"

# 6b. Install chromium into the service user's own home, so the hardened unit
# (which sees only ${INSTALL_DIR}) can find it. Skipped if already present.
BROWSERS_PATH="${INSTALL_DIR}/.cache/ms-playwright"
if sudo test -d "${BROWSERS_PATH}"; then
  echo -e "${GRAY}  Chromium already installed at ${BROWSERS_PATH}${NC}"
else
  run sudo -u "${SERVICE_USER}" env HOME="${INSTALL_DIR}" \
    PLAYWRIGHT_BROWSERS_PATH="${BROWSERS_PATH}" \
    "${INSTALL_DIR}/node_modules/.bin/patchright" install chromium
  echo -e "${GREEN}✓ Installed chromium for ${SERVICE_USER}${NC}"
fi

if sudo test -d "${INSTALL_DIR}/browser/profile"; then
  echo -e "${GREEN}✓ Browser profile present${NC}"
else
  echo -e "${YELLOW}⚠ No browser profile yet — run 'npm run login' on a desktop, then 'npm run sync:profile'${NC}"
fi

# 7. Install systemd service
run sudo cp "${INSTALL_DIR}/ai-usage.service" /etc/systemd/system/${SERVICE_NAME}.service
run sudo systemctl daemon-reload
run sudo systemctl enable ${SERVICE_NAME}
run sudo systemctl restart ${SERVICE_NAME}

echo ""
echo -e "${GREEN}=== Installation complete ===${NC}"
echo "  Service: systemctl status ${SERVICE_NAME}"
echo "  Logs:    journalctl -u ${SERVICE_NAME} -f"
echo "  Dashboard: http://$(hostname -I | awk '{print $1}'):9199/"
echo ""
