#!/usr/bin/env bash
# Run as setup.sh's KIOSK_USER from an installed checkout. This script fetches
# master itself: do not pull first, or the previous running code cannot be saved.
# An optional checkout path supports bootstrapping from a fetched script.
set -euo pipefail

finish_update() {
  local status=$?
  trap - EXIT
  set +e
  if [ "$cutover" = true ] && [ "$committed" = false ]; then
    echo "Update failed; restoring the previous code and virtual environment." >&2
    local restore_failed=false
    sudo systemctl stop fw-gatekeeper-kiosk || restore_failed=true
    # A failed checkout can modify files before advancing HEAD. Restore the
    # previously verified clean tree even when HEAD still names old_head.
    git reset --hard "$old_head" || restore_failed=true
    if [ -e "$backup" ] || [ -L "$backup" ]; then
      rm -f "$kiosk/venv" && mv "$backup" "$kiosk/venv" || restore_failed=true
    fi
    if [ "$kiosk_active" = true ]; then
      sudo systemctl start fw-gatekeeper-kiosk || restore_failed=true
    fi
    if [ "$watchdog_active" = true ]; then
      sudo systemctl start fw-gatekeeper-watchdog.timer || restore_failed=true
    fi
    if [ "$restore_failed" = true ]; then
      echo "Restoration failed; inspect systemctl status and $backup before retrying." >&2
      exit 1
    fi
  fi
  if [ "$committed" = false ] && [ -n "$release" ]; then
    rm -rf "$release"
  fi
  exit "$status"
}

update_kiosk() {
  if [ "$(id -u)" -eq 0 ]; then
    echo "Run update.sh as the kiosk user, not with sudo or as root." >&2
    exit 1
  fi
  cd -P "${1:-$(dirname "$0")/..}"
  repo=$PWD
  kiosk="$repo/pi-kiosk"
  # flock belongs to util-linux, included in Raspberry Pi OS. Keep the lock
  # outside the tracked tree and refuse simultaneous updates.
  exec 9>"$(git rev-parse --git-path kiosk-update.lock)"
  flock -n 9 || { echo "Another kiosk update is running." >&2; exit 1; }
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "Tracked files have local changes; commit or restore them before updating." >&2
    exit 1
  fi
  if [ ! -O "$kiosk/venv" ]; then
    echo "Run as the owner of the installed venv (setup.sh's KIOSK_USER)." >&2
    exit 1
  fi
  old_head=$(git rev-parse HEAD)
  git fetch origin master
  target=$(git rev-parse FETCH_HEAD)
  git merge-base --is-ancestor "$old_head" "$target" || {
    echo "The installed checkout cannot fast-forward to origin/master." >&2
    exit 1
  }

  # Build in its permanent location: moving a venv breaks absolute shebangs
  # in pip/cmake. Only the venv symlink changes at cutover. The running service
  # and its code remain untouched while downloads and native builds run.
  release=""
  cutover=false
  committed=false
  backup="$kiosk/.venv-before-update"
  if [ -e "$backup" ] || [ -L "$backup" ]; then
    echo "An earlier update left $backup; recover it before retrying." >&2
    exit 1
  fi
  trap finish_update EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  mkdir -p "$kiosk/.venv-releases"
  release=$(mktemp -d "$kiosk/.venv-releases/release.XXXXXX")
  cd "$release"
  git -C "$repo" show "$target:pi-kiosk/requirements-build.lock" > requirements-build.lock
  git -C "$repo" show "$target:pi-kiosk/requirements.lock" > requirements.lock
  python3 -m venv venv --system-site-packages
  # These install commands match setup.sh, including the native build PATH.
  ./venv/bin/python -m pip install --require-hashes -r requirements-build.lock
  PATH="$PWD/venv/bin:$PATH" ./venv/bin/python -m pip install --require-hashes --no-build-isolation -r requirements.lock
  cd "$repo"

  # Recheck before cutover in case a person edited code during the build.
  [ "$(git rev-parse HEAD)" = "$old_head" ]
  [ -z "$(git status --porcelain --untracked-files=no)" ]
  kiosk_active=false
  watchdog_active=false
  if systemctl is-active --quiet fw-gatekeeper-kiosk; then kiosk_active=true; fi
  if systemctl is-active --quiet fw-gatekeeper-watchdog.timer; then watchdog_active=true; fi
  cutover=true
  # Stop the timer AND any already-running watchdog job before the kiosk.
  sudo systemctl stop fw-gatekeeper-watchdog.timer fw-gatekeeper-watchdog.service
  sudo systemctl stop fw-gatekeeper-kiosk
  git merge --ff-only "$target"
  mv "$kiosk/venv" "$backup"
  ln -s "$release/venv" "$kiosk/venv"
  sudo systemctl restart fw-gatekeeper-kiosk
  sudo systemctl is-active --quiet fw-gatekeeper-kiosk
  if [ "$watchdog_active" = true ]; then
    sudo systemctl start fw-gatekeeper-watchdog.timer
  fi
  committed=true
  # Retain only the active release. Never remove arbitrary symlink targets.
  if [ -L "$backup" ]; then
    previous=$(readlink -f "$backup")
    case "$previous" in
      "$kiosk/.venv-releases/release."*/venv) rm -rf "$(dirname "$previous")" ;;
    esac
  fi
  rm -rf "$backup"
  echo "Kiosk updated to $target. Verify scanning before updating the next kiosk."
}

# Parse the complete function before a fast-forward can replace this file.
{ update_kiosk "$@"; exit; }
