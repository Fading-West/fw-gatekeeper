#!/usr/bin/env bash
# Run as setup.sh's KIOSK_USER. Code and dependencies are staged at permanent
# paths; the launcher tries them only while this updater is alive. Do not pull
# first. An optional checkout path supports bootstrapping a fetched updater.
set -euo pipefail

stage_dependencies() {
  python3 -m venv venv --system-site-packages
  ./venv/bin/python -m pip install --require-hashes -r requirements-build.lock
  PATH="$PWD/venv/bin:$PATH" ./venv/bin/python -m pip install --require-hashes --no-build-isolation -r requirements.lock
}

collect_unused() {
  local obsolete
  for obsolete in "$kiosk/.kiosk-releases"/release.* "$kiosk/.venv-releases"/release.*; do
    [ -d "$obsolete" ] || continue
    python3 "$helper" collect "$repo" "$obsolete"
  done
}

finish_update() {
  local status=$?
  trap - EXIT
  trap '' INT TERM HUP
  set +e
  if [ "$committed" = false ]; then
    # Cancel the trial and collect unused builds. The collector retains any
    # release whose supervisor or child could still be shutting down.
    python3 "$helper" cancel "$repo"
    collect_unused
    echo "Update failed; the launcher keeps/restores the previous code and venv." >&2
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
  # The source checkout remains unchanged. Its entry point dispatches to the
  # committed release's updater so later releases can update this procedure.
  # An explicitly fetched bootstrap script always runs its own implementation.
  if [ -f "$repo/.git/kiosk-current.json" ] && [ "$(readlink -f "$0")" = "$kiosk/update.sh" ]; then
    active=$(python3 "$repo/.git/kiosk-launch.py" current "$repo")
    exec bash "$active/update.sh" "$repo"
  fi
  # setup.sh uses this path in its systemd service. Refuse paths that
  # systemd would parse differently; all filesystem arguments remain quoted.
  case "$repo" in *[[:space:]%\\\"\']*) echo "Unsupported systemd checkout path: $repo" >&2; exit 1 ;; esac
  [ -d .git ] || { echo "Use the installed clone, not a linked Git worktree." >&2; exit 1; }
  exec 9>"$repo/.git/kiosk-update.lock"
  flock -n 9 || { echo "Another kiosk update is running." >&2; exit 1; }
  if [ -e "$kiosk/.venv-before-update" ] || [ -L "$kiosk/.venv-before-update" ]; then
    echo "Recover the previous updater's .venv-before-update backup before retrying." >&2; exit 1;
  fi
  if [ ! -O "$repo" ]; then
    echo "Run as the checkout/venv owner (setup.sh's KIOSK_USER)." >&2
    exit 1
  fi
  [ "$(systemctl show --property=User --value fw-gatekeeper-kiosk)" = "$(id -un)" ] || {
    echo "Run as the configured kiosk service User." >&2; exit 1;
  }
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "Tracked files have local changes; restore them before updating." >&2
    exit 1
  fi
  systemctl is-active --quiet fw-gatekeeper-kiosk || {
    echo "Start and verify the existing kiosk before updating." >&2; exit 1;
  }
  # Recover interrupted staging before checking free space or fetching again.
  helper="$repo/.git/kiosk-launch.py"
  if [ -f "$helper" ]; then
    python3 "$helper" cancel "$repo"
    collect_unused
  fi
  # Refuse even code-only updates when the OS/SQLite reserve is already low.
  python3 -c 'import shutil, sys; sys.exit(0 if shutil.disk_usage(sys.argv[1]).free >= 512 * 1024**2 else "Need at least 512 MiB free for an update.")' "$repo"
  old_head=$(git rev-parse HEAD)
  git fetch origin master
  target=$(git rev-parse FETCH_HEAD)
  git merge-base --is-ancestor "$old_head" "$target" || {
    echo "The installed checkout cannot fast-forward to origin/master." >&2; exit 1;
  }
  # Install the stable launcher once, before any unit references it. App updates
  # must not replace the recovery code with an unverified candidate launcher.
  # Its state protocol is persistent; changing it requires a separate migration.
  helper="$repo/.git/kiosk-launch.py"
  if [ ! -f "$helper" ]; then
    git show "$target:pi-kiosk/tools/kiosk_release.py" > "$helper.next"
    sync "$helper.next"
    mv -f "$helper.next" "$helper"
    sync "$repo/.git"
  fi
  if [ ! -f "$repo/.git/kiosk-arguments.json" ]; then
    python3 "$helper" arguments "$repo" "$(systemctl show --property=MainPID --value fw-gatekeeper-kiosk)"
  fi
  active=$(python3 "$helper" current "$repo")
  deployed=$(python3 "$helper" revision "$repo" "$old_head")
  git merge-base --is-ancestor "$deployed" "$target" || {
    echo "The deployed revision cannot fast-forward to origin/master." >&2; exit 1;
  }
  [ -O "$active/venv" ] || { echo "Run as the installed venv owner." >&2; exit 1; }
  # Repair a convenience symlink if a successful retirement was interrupted.
  python3 "$helper" retire "$repo"
  # A killed updater's trial is never a committed release. Cancel it before
  # building, then let the launcher finish returning to the committed version.
  python3 "$helper" cancel "$repo"
  committed=false
  trap finish_update EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP

  mkdir -p "$kiosk/.kiosk-releases" "$kiosk/.venv-releases"
  # Keep the active code and the permanently located active venv. Reclaim
  # interrupted builds, avoiding accumulation on small SD cards.
  active_venv=$(readlink -f "$active/venv")
  collect_unused
  release=$(mktemp -d "$kiosk/.kiosk-releases/release.XXXXXX")
  git archive "$target" pi-kiosk | tar -x -C "$release"
  cd "$release/pi-kiosk"
  if cmp -s requirements-build.lock "$active/requirements-build.lock" && cmp -s requirements.lock "$active/requirements.lock"; then
    ln -s "$active_venv" venv
  else
    python3 "$helper" space "$repo" "$active_venv"
    environment=$(mktemp -d "$kiosk/.venv-releases/release.XXXXXX")
    cp requirements-build.lock requirements.lock "$environment/"
    cd "$environment"
    mkdir -p "$environment/tmp"
    export -f stage_dependencies
    PIP_NO_CACHE_DIR=1 TMPDIR="$environment/tmp" python3 "$helper" guard "$repo" bash -euo pipefail -c stage_dependencies
    ln -s "$environment/venv" "$release/pi-kiosk/venv"
  fi
  cd "$repo"
  [ "$(git rev-parse HEAD)" = "$old_head" ]
  [ -z "$(git status --porcelain --untracked-files=no)" ]
  # Flush the full candidate before publishing a trial record (power loss).
  sync -f "$release"
  python3 "$helper" prepare "$repo" "$release/pi-kiosk" "$target" "$$"

  # Migrates older setup units too; the launcher retains their original arguments.
  # Publish a complete override atomically, leaving the base unit intact.
  override="$repo/.git/kiosk-unit.conf"
  cat > "$override" <<EOF
[Unit]
StartLimitIntervalSec=0

[Service]
WorkingDirectory=$kiosk
ExecStart=
ExecStart=/usr/bin/python3 $helper launch $repo --camera auto
Restart=always
RestartSec=5
KillMode=control-group
EOF
  sudo mkdir -p /etc/systemd/system/fw-gatekeeper-kiosk.service.d
  sudo install -m 644 "$override" /etc/systemd/system/fw-gatekeeper-kiosk.service.d/release.conf.next
  sudo sync /etc/systemd/system/fw-gatekeeper-kiosk.service.d/release.conf.next
  sudo mv -f /etc/systemd/system/fw-gatekeeper-kiosk.service.d/release.conf.next /etc/systemd/system/fw-gatekeeper-kiosk.service.d/release.conf
  sudo sync /etc/systemd/system/fw-gatekeeper-kiosk.service.d
  sudo systemctl daemon-reload
  # SIGTERM triggers Restart=always. Unlike stop/restart, there is no disabled
  # service window if the updater or its SSH connection disappears mid-command.
  sudo systemctl kill --kill-whom=main --signal=SIGTERM fw-gatekeeper-kiosk
  python3 "$helper" health "$repo"
  python3 "$helper" commit "$repo"
  committed=true
  python3 "$helper" retire "$repo"
  collect_unused
  echo "Kiosk updated to $target. Verify scanning before updating the next kiosk."
}

{ update_kiosk "$@"; exit; }
