#!/usr/bin/env bash
# Run from any directory with uv 0.12.13 available (or set UV=/path/to/uv).
set -euo pipefail
cd "$(dirname "$0")/.."
UV="${UV:-uv}"
if [[ "$("$UV" --version | cut -d ' ' -f 1-2)" != "uv 0.12.13" ]]; then
  echo "Use uv 0.12.13 to regenerate the checked-in Python locks." >&2
  exit 1
fi
"$UV" pip compile face-service/requirements.txt \
  --python-version 3.11 --python-platform x86_64-manylinux_2_36 \
  --generate-hashes --only-binary=:all: \
  --custom-compile-command 'bash scripts/lock-python-dependencies.sh' \
  --output-file face-service/requirements.lock --quiet
"$UV" pip compile pi-kiosk/requirements-build.txt \
  --python-version 3.11 --python-platform aarch64-manylinux_2_36 \
  --generate-hashes --only-binary=:all: \
  --custom-compile-command 'bash scripts/lock-python-dependencies.sh' \
  --output-file pi-kiosk/requirements-build.lock --quiet
"$UV" pip compile pi-kiosk/requirements.txt \
  --python-version 3.11 --python-platform aarch64-manylinux_2_36 \
  --generate-hashes --build-constraints pi-kiosk/requirements-build.txt \
  --custom-compile-command 'bash scripts/lock-python-dependencies.sh' \
  --output-file pi-kiosk/requirements.lock --quiet
