#!/usr/bin/env bash
# FW Gatekeeper — refresh an installed kiosk's locked Python dependencies and
# restart it. Run as the kiosk user after pulling new code:
#
#   cd /opt/fw-gatekeeper && sudo git pull origin master && bash pi-kiosk/update.sh
#
# The two install commands are copied verbatim from setup.sh (test_update_script.py
# keeps them identical). Rerunning is safe: pip skips already-installed pins.
# If either install fails, the script exits before restarting the service.
set -euo pipefail

cd "$(dirname "$0")"

./venv/bin/python -m pip install --require-hashes -r requirements-build.lock
PATH="$PWD/venv/bin:$PATH" ./venv/bin/python -m pip install --require-hashes --no-build-isolation -r requirements.lock
sudo systemctl restart fw-gatekeeper-kiosk
