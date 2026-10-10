#!/usr/bin/env bash
# FW Gatekeeper — refresh an installed kiosk's locked Python dependencies and
# restart it. Run as the kiosk user (pi), not root, after pulling new code:
#
#   cd /opt/fw-gatekeeper && git pull origin master && bash pi-kiosk/update.sh
#
# setup.sh makes the kiosk user own the checkout and venv; installing as root
# would leave root-owned files that break later updates. sudo is used only for
# the restart. The two install commands are copied verbatim from setup.sh
# (test_update_script.py keeps them identical). Rerunning is safe: pip skips
# already-installed pins. If either install fails, the script exits before
# restarting the service.
set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  echo "Run update.sh as the kiosk user (e.g. pi), not with sudo or as root." >&2
  exit 1
fi

cd "$(dirname "$0")"

./venv/bin/python -m pip install --require-hashes -r requirements-build.lock
PATH="$PWD/venv/bin:$PATH" ./venv/bin/python -m pip install --require-hashes --no-build-isolation -r requirements.lock
sudo systemctl restart fw-gatekeeper-kiosk
