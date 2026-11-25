"""Check installer ownership for accounts without a same-named group."""
import grp
import os
from pathlib import Path
import pwd
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock


class SetupPrimaryGroupTests(unittest.TestCase):
    source = Path(__file__).with_name("setup.sh").read_text()

    def test_checkout_and_display_ownership_resolve_the_login_group(self):
        account = pwd.getpwnam("nobody")
        try:
            grp.getgrnam(account.pw_name)
        except KeyError:
            pass
        else:
            self.skipTest("host has a group named nobody")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / "kiosk-home"
            install = root / "checkout"
            (home / ".config/autostart").mkdir(parents=True)
            (home / "fw-gatekeeper-display.sh").touch()
            install.mkdir()
            commands = [line for line in self.source.splitlines() if line.startswith("chown ")]
            self.assertEqual(len(commands), 3)
            # Real GNU chown resolves the login group. The --from filter rules
            # out ownership changes to the synthetic files on any runner.
            non_owner = os.getuid() + 1
            result = subprocess.run(
                ["bash", "-ec", f'chown() {{ command chown --from=+{non_owner} "$@"; }}\n' + "\n".join(commands)],
                env={**os.environ, "KIOSK_USER": account.pw_name, "KIOSK_HOME": str(home), "INSTALL_DIR": str(install)},
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_private_tree_uses_the_account_primary_gid(self):
        program = self.source.split("<<'PRIVATE_DATA'\n", 1)[1].split("\nPRIVATE_DATA", 1)[0]
        account = SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid() + 1)
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory) / "data"
            data.mkdir(mode=0o755)
            evidence = data / "attendance.db"
            evidence.touch(mode=0o644)
            with mock.patch.object(sys, "argv", ["-", str(data), "kiosk-service"]), \
                    mock.patch.object(pwd, "getpwnam", return_value=account), \
                    mock.patch.object(grp, "getgrnam", side_effect=KeyError("no same-named group")), \
                    mock.patch.object(os, "fchown") as chown:
                exec(compile(program, "setup.sh:PRIVATE_DATA", "exec"), {})
            self.assertEqual(chown.call_count, 2)
            self.assertTrue(all(call.args[1:] == (account.pw_uid, account.pw_gid)
                                for call in chown.call_args_list))
            self.assertEqual(stat.S_IMODE(data.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(evidence.stat().st_mode), 0o600)


if __name__ == "__main__":
    unittest.main()
