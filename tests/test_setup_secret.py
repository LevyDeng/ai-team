"""Exercise the actual embedded deployment secret check without Docker or SSH."""
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "server" / "provision-relay.sh").read_text(encoding="utf-8")
CHECK = SOURCE.split("<<'PY'\n", 1)[1].split("\nPY\n", 1)[0]


class DeploymentSecretTests(unittest.TestCase):
    def check_secret(self, incoming, existing=None, expected=0):
        with tempfile.TemporaryDirectory() as folder:
            new = pathlib.Path(folder) / "incoming.env"
            old = pathlib.Path(folder) / "existing.env"
            new.write_text(incoming, encoding="utf-8")
            if existing is not None:
                old.write_text(existing, encoding="utf-8")
            result = subprocess.run([sys.executable, "-c", CHECK, str(new), str(old)],
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self.assertEqual(result.returncode, expected, result.stderr)
            self.assertEqual(new.read_text(encoding="utf-8"), incoming)
            if existing is not None:
                self.assertEqual(old.read_text(encoding="utf-8"), existing)
            else:
                self.assertFalse(old.exists())
            self.assertNotIn("a" * 64, result.stdout + result.stderr)

    def test_new_install(self):
        self.check_secret("WINDOWS_MCP_SECRET=" + "a" * 64 + "\n")

    def test_matching_secret_with_quotes_and_other_values(self):
        self.check_secret("WINDOWS_MCP_SECRET=" + "a" * 64 + "\n",
                          '# Retain\nWINDOWS_MCP_SECRET="' + "a" * 64 + '"\nSSH_TARGET=relay@example.invalid\n')

    def test_mismatch_is_rejected_without_changes(self):
        self.check_secret("WINDOWS_MCP_SECRET=" + "a" * 64 + "\n",
                          "WINDOWS_MCP_SECRET=" + "b" * 64 + "\n", expected=1)

    def test_duplicate_is_rejected(self):
        self.check_secret(("WINDOWS_MCP_SECRET=" + "a" * 64 + "\n") * 2, expected=1)

    def test_invalid_secret_is_rejected(self):
        self.check_secret("WINDOWS_MCP_SECRET=invalid\n", expected=1)

    def test_missing_secret_is_rejected(self):
        self.check_secret("SSH_PORT=22\n", expected=1)


if __name__ == "__main__":
    unittest.main()
