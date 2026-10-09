"""Update installer-managed settings without executing or erasing local policy."""

import ast
import os
from pathlib import Path
import tempfile


MANAGED_NAMES = (
    "SERVER_URL", "KIOSK_ID", "KIOSK_TYPE", "KIOSK_NAME", "KIOSK_API_KEY",
    "KIOSK_UI_KEY", "KIOSK_SUPERVISOR_PIN",
)


def validate_managed_bindings(module: ast.Module) -> None:
    """Refuse binding forms that cannot be replaced without erasing policy."""
    supported_targets = set()
    for statement in module.body:
        if isinstance(statement, ast.Assign) and len(statement.targets) == 1:
            target = statement.targets[0]
        elif isinstance(statement, ast.AnnAssign):
            target = statement.target
        else:
            continue
        if isinstance(target, ast.Name) and target.id in MANAGED_NAMES:
            supported_targets.add(target)

    for node in ast.walk(module):
        unsupported = False
        if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            unsupported = node.id in MANAGED_NAMES and node not in supported_targets
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            # A wildcard can overwrite managed settings without naming them.
            unsupported = any(
                alias.name == "*" or (alias.asname or alias.name.split(".")[0]) in MANAGED_NAMES
                for alias in node.names
            )
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.ExceptHandler)):
            unsupported = node.name in MANAGED_NAMES
        elif isinstance(node, ast.arg):
            unsupported = node.arg in MANAGED_NAMES
        elif isinstance(node, (ast.MatchAs, ast.MatchStar)):
            unsupported = node.name in MANAGED_NAMES
        elif isinstance(node, ast.MatchMapping):
            unsupported = node.rest in MANAGED_NAMES
        if unsupported:
            # Never include source, values or names in diagnostics.
            raise ValueError("Managed settings must use top-level standalone simple assignments")


def updated_source(existing: str, values: dict[str, str]) -> str:
    if any(not isinstance(values.get(name), str) or not values[name] for name in MANAGED_NAMES):
        raise ValueError("Every installer-managed kiosk setting is required")
    if values["KIOSK_TYPE"] not in {"entry", "exit", "auto"}:
        raise ValueError("Kiosk type must be entry, exit or auto")
    try:
        module = ast.parse(existing)
    except SyntaxError:
        # Do not print the invalid source line: it may contain credentials.
        raise ValueError("Existing local configuration is invalid; repair it before setup") from None
    validate_managed_bindings(module)
    lines = existing.splitlines(keepends=True)
    replacements = {}
    removed: set[int] = set()
    written = set()
    for node in module.body:
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            names = {part.id for target in targets for part in ast.walk(target) if isinstance(part, ast.Name)}
            if names.intersection(MANAGED_NAMES):
                if len(targets) != 1 or not isinstance(targets[0], ast.Name):
                    raise ValueError("Managed settings must use standalone simple assignments")
                # Refuse a semicolon-sharing line instead of deleting unrelated policy.
                peers = [other for other in module.body if other is not node
                         and other.lineno <= node.end_lineno and other.end_lineno >= node.lineno]
                if peers:
                    raise ValueError("Managed settings must each occupy their own lines")
                name = targets[0].id
                replacements[node.lineno - 1] = f"{name} = {values[name]!r}\n"
                removed.update(range(node.lineno, node.end_lineno))
                written.add(name)
    preserved = "".join(replacements.get(index, line) for index, line in enumerate(lines) if index not in removed).rstrip()
    if not preserved:
        preserved = '"""Local kiosk configuration; operator overrides are preserved by setup."""'
    result = preserved + "\n\n# Installer-managed connection and display settings.\n"
    result += "".join(f"{name} = {values[name]!r}\n" for name in MANAGED_NAMES if name not in written)
    try:
        compile(result, "config_local.py", "exec")
    except SyntaxError:
        raise ValueError("Updated local configuration could not be validated") from None
    return result


def update_config(path: Path, values: dict[str, str]) -> None:
    if path.is_symlink():
        raise ValueError("Local configuration must be a regular file")
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    result = updated_source(existing, values)
    old_stat = path.stat() if path.exists() else None
    descriptor, temporary = tempfile.mkstemp(prefix=".config_local.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(result)
            handle.flush()
            os.fsync(handle.fileno())
            os.fchmod(handle.fileno(), 0o600)
            if old_stat is not None:
                os.fchown(handle.fileno(), old_stat.st_uid, old_stat.st_gid)
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == "__main__":
    try:
        update_config(Path("config_local.py"), {name: os.environ.get(name, "") for name in MANAGED_NAMES})
    except (OSError, ValueError, UnicodeError):
        # OS errors and source diagnostics can include confidential filenames/values.
        raise SystemExit("Kiosk configuration update failed; setup stopped. Inspect local configuration before retrying.") from None
