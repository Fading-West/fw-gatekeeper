#!/usr/bin/env bash
# FW Gatekeeper — pull kiosk code, install locked dependencies, and restart.
# Run as setup.sh's KIOSK_USER, not root:
#   cd /opt/fw-gatekeeper && bash pi-kiosk/update.sh
# sudo is used only for the restart. The install commands match setup.sh.
# A failed install aborts before restart but can partially update the venv.
set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  echo "Run update.sh as the kiosk user, not with sudo or as root." >&2
  exit 1
fi
KIOSK_USER="${KIOSK_USER:-$(id -un)}"
if [ "$(id -un)" != "$KIOSK_USER" ]; then
  echo "Run update.sh as KIOSK_USER ($KIOSK_USER)." >&2
  exit 1
fi

# Read this whole block before git pull can replace the running script.
{
  cd "$(dirname "$0")/.."
  git pull origin master
  cd pi-kiosk
  ./venv/bin/python -m pip install --require-hashes -r requirements-build.lock
  PATH="$PWD/venv/bin:$PATH" ./venv/bin/python -m pip install --require-hashes --no-build-isolation -r requirements.lock
  sudo systemctl restart fw-gatekeeper-kiosk
  exit
}
