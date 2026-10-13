#!/usr/bin/env python3
"""Small persistent launcher/state protocol for interruption-safe kiosk updates.

current.json is the only committed release. pending.json is a trial, valid only
while its updater (PID, start time AND boot ID) is alive. Neither code nor venv
is moved. The supervisor abandons a trial when its updater disappears, including
SIGKILL/SSH disconnect; after reboot a pending trial is always ignored.
"""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
import urllib.request

RESERVE = 512 * 1024 * 1024


def identity(pid):
    try:
        # comm may contain spaces or parentheses. Fields after its last ')' start
        # at field 3; field 22 is the process start time. A zombie is not alive.
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        if fields[0] == "Z":
            return None
        return [int(pid), fields[19], Path("/proc/sys/kernel/random/boot_id").read_text().strip()]
    except (OSError, IndexError):
        return None


def read(path, default=None):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return default


def durable_write(path, value):
    temporary = path.with_suffix(".tmp")
    with temporary.open("w") as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    sync_directory(path.parent)


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def current(repo):
    return read(repo / ".git/kiosk-current.json", {"directory": str(repo / "pi-kiosk")})


def selected(repo):
    committed = current(repo)
    pending = read(repo / ".git/kiosk-pending.json")
    if pending and identity(pending["owner"][0]) == pending["owner"]:
        return pending["release"]
    return committed


def stop_child(child):
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=20)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()


def launch(repo, arguments):
    child = None
    rejected = None

    def terminate(_number, _frame):
        if child is not None:
            stop_child(child)
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    signal.signal(signal.SIGHUP, terminate)
    while True:
        release = selected(repo)
        if release == rejected:
            release = current(repo)
        directory = Path(release["directory"])
        try:
            child = subprocess.Popen([str(directory / "venv/bin/python"), "main.py", *arguments],
                                     cwd=directory, start_new_session=True)
        except OSError:
            if release == current(repo):
                raise
            rejected = release
            continue
        # Health checks must identify THIS launch, rather than an old HTTP server.
        try:
            durable_write(repo / ".git/kiosk-running.json",
                          {"release": release, "process": identity(os.getpid()),
                           "child": identity(child.pid)})
        except OSError as error:
            # A full/read-only disk must not prevent the committed kiosk booting.
            # A trial without a running marker cannot pass the health gate.
            print(f"Cannot record launch: {error}", file=sys.stderr)
        while child.poll() is None:
            time.sleep(0.5)
            next_release = selected(repo)
            if next_release == rejected:
                next_release = current(repo)
            if next_release != release:
                stop_child(child)
                break
        else:
            if release != current(repo):
                # Reject a crashing trial immediately, independently of the
                # watchdog or the updater's health timeout.
                rejected = release
                continue
            return child.returncode or 1  # systemd's Restart=always retries failures


def guard(repo, command):
    child = subprocess.Popen(command, start_new_session=True)

    def terminate(number, _frame):
        stop_child(child)
        raise SystemExit(128 + number)

    for number in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(number, terminate)
    try:
        while child.poll() is None:
            if shutil.disk_usage(repo).free < RESERVE:
                raise RuntimeError("Build exhausted the update disk reserve; keeping the old kiosk.")
            time.sleep(0.5)
        if child.returncode:
            raise SystemExit(child.returncode)
    finally:
        stop_child(child)


def prepare(repo, directory, revision, owner):
    original = repo / "pi-kiosk"
    # Share ignored/untracked runtime files, including custom relative database
    # paths inside tracked directories. Do not resurrect deleted tracked code.
    tracked = set(subprocess.check_output(["git", "-C", str(repo), "ls-files", "-z", "pi-kiosk"]).decode().split("\0"))
    excluded = {"venv", "venv.next", "__pycache__", ".kiosk-releases", ".venv-releases", ".venv-retired", ".venv-before-update"}

    def share(source, destination):
        if source.name in excluded:
            return
        relative = source.relative_to(repo).as_posix()
        if source.is_dir() and not source.is_symlink():
            has_tracked = any(name.startswith(relative + "/") for name in tracked)
            if not destination.exists() and not has_tracked:
                destination.symlink_to(source, target_is_directory=True)
                return
            if destination.exists() and not destination.is_dir():
                raise RuntimeError(f"New code conflicts with runtime directory {source}")
            destination.mkdir(exist_ok=True)
            for child in source.iterdir():
                share(child, destination / child.name)
        elif relative not in tracked:
            if destination.exists() or destination.is_symlink():
                raise RuntimeError(f"New code conflicts with runtime file {source}")
            destination.symlink_to(source)

    for source in original.iterdir():
        share(source, directory / source.name)
    # Flush runtime links as well as the staged code/venv before publishing.
    os.sync()
    release = {"directory": str(directory), "revision": revision}
    # Allocate and flush the commit record before touching the running service.
    durable_write(repo / ".git/kiosk-current.next", release)
    owner_identity = identity(owner)
    if owner_identity is None:
        raise RuntimeError("Updater is no longer alive")
    durable_write(repo / ".git/kiosk-pending.json", {"release": release, "owner": owner_identity})


def healthy(repo):
    expected = read(repo / ".git/kiosk-pending.json")["release"]
    timeout = float(os.environ.get("KIOSK_UPDATE_TIMEOUT", "300"))
    stable_seconds = float(os.environ.get("KIOSK_HEALTH_STABLE_SECONDS", "10"))
    deadline = time.monotonic() + timeout
    stable_since = None
    previous_process = None
    while time.monotonic() < deadline:
        running = read(repo / ".git/kiosk-running.json", {})
        process = running.get("process")
        child = running.get("child")
        launch_identity = [process, child]
        ok = (running.get("release") == expected and process is not None and child is not None
              and identity(process[0]) == process and identity(child[0]) == child)
        try:
            with urllib.request.urlopen(os.environ.get("KIOSK_HEALTH_URL", "http://localhost:5555/health"),
                                        timeout=2) as response:
                snapshot = json.load(response)
            ok = ok and snapshot.get("status") == "ok" and snapshot.get("camera_ok") is True and snapshot.get("model_ok") is True
        except (OSError, ValueError):
            ok = False
        if not ok or launch_identity != previous_process:
            stable_since = None
        if ok:
            stable_since = stable_since or time.monotonic()
            if time.monotonic() - stable_since >= stable_seconds:
                return
        previous_process = launch_identity
        time.sleep(0.5)
    raise RuntimeError("New kiosk did not reach stable camera/model health; restoring the old release.")


def collect(repo, obsolete):
    protected = [Path(current(repo)["directory"])]
    running = read(repo / ".git/kiosk-running.json", {})
    if any(process and identity(process[0]) == process
           for process in (running.get("process"), running.get("child"))):
        protected.append(Path(running["release"]["directory"]))
    for directory in protected:
        if directory == obsolete / "pi-kiosk" or (directory / "venv").resolve() == obsolete / "venv":
            return
    shutil.rmtree(obsolete)


def retire_original_venv(repo):
    original = repo / "pi-kiosk/venv"
    active = Path(current(repo)["directory"]) / "venv"
    destination = active.resolve()
    if destination == original:
        return  # lock-identical releases may still use the original environment
    # Only called after a successful health gate and durable commit. Retiring an
    # unused directory does not affect the launcher or its permanently located
    # venv. If killed here, the next updater repairs the convenience symlink.
    retired = repo / "pi-kiosk/.venv-retired"
    if original.is_dir() and not original.is_symlink():
        os.rename(original, retired)
    temporary = original.with_suffix(".next")
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(destination, target_is_directory=True)
    os.replace(temporary, original)
    if retired.exists():
        shutil.rmtree(retired)


def main():
    command, repo_arg, *arguments = sys.argv[1:]
    repo = Path(repo_arg).resolve()
    if command == "launch":
        raise SystemExit(launch(repo, arguments))
    if command == "current":
        print(current(repo)["directory"])
    elif command == "revision":
        print(current(repo).get("revision", arguments[0]))
    elif command == "prepare":
        prepare(repo, Path(arguments[0]), arguments[1], int(arguments[2]))
    elif command == "health":
        healthy(repo)
    elif command == "commit":
        os.replace(repo / ".git/kiosk-current.next", repo / ".git/kiosk-current.json")
        sync_directory(repo / ".git")
        (repo / ".git/kiosk-pending.json").unlink(missing_ok=True)
    elif command == "cancel":
        (repo / ".git/kiosk-pending.json").unlink(missing_ok=True)
        sync_directory(repo / ".git")
    elif command == "guard":
        guard(repo, arguments)
    elif command == "collect":
        collect(repo, Path(arguments[0]))
    elif command == "retire":
        retire_original_venv(repo)
    elif command == "space":
        venv = Path(arguments[0])
        size = sum(path.stat().st_blocks * 512 for path in venv.rglob("*") if path.is_file())
        # Native wheels, source builds and downloads need more than the installed
        # size. Keep a separate reserve for SQLite and other running OS services.
        needed = max(size * 2, 2 * 1024**3) + RESERVE
        if shutil.disk_usage(repo).free < needed:
            raise RuntimeError(f"Need {needed // 1024**2} MiB free for a second venv and native builds.")
    else:
        raise SystemExit(f"Unknown command: {command}")


if __name__ == "__main__":
    main()
