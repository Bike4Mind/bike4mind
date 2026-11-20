import base64
import importlib.util
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location("scrubber", Path(__file__).with_name("scrub-e2e-token.py"))
scrubber = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scrubber)


def archive(entries):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as destination:
        for name, body in entries.items():
            destination.writestr(name, body)
    return output.getvalue()


class ScrubE2ESecretsTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.environment = patch.dict(os.environ, {
            "E2E_WAF_BYPASS_TOKEN": "fake-edge-token-123456789",
            "E2E_CLEANUP_SECRET": "fake-cleanup-secret-987654321",
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_scrubs_both_secrets_in_raw_nested_and_embedded_reports(self):
        original = b"fake-edge-token-123456789 fake-cleanup-secret-987654321"
        nested = archive({"network.trace": original})
        report_zip = archive({"trace.zip": nested})
        (self.root / "trace.zip").write_bytes(report_zip)
        (self.root / "results.json").write_bytes(original)
        (self.root / "index.html").write_bytes(b"data:application/zip;base64," + base64.b64encode(report_zip))

        self.assertEqual(scrubber.main([self.root]), 0)
        self.assertEqual((self.root / "results.json").read_bytes(), b"[scrubbed] [scrubbed]")
        for data in (
            (self.root / "trace.zip").read_bytes(),
            base64.b64decode((self.root / "index.html").read_bytes().split(b",", 1)[1]),
        ):
            with zipfile.ZipFile(io.BytesIO(data)) as outer:
                with zipfile.ZipFile(io.BytesIO(outer.read("trace.zip"))) as inner:
                    self.assertEqual(inner.read("network.trace"), b"[scrubbed] [scrubbed]")

    def test_cleanup_only_is_scrubbed_when_waf_token_is_unset(self):
        os.environ.pop("E2E_WAF_BYPASS_TOKEN")
        file = self.root / "network.trace"
        file.write_text(os.environ["E2E_CLEANUP_SECRET"])
        self.assertEqual(scrubber.main([file]), 0)
        self.assertEqual(file.read_text(), "[scrubbed]")

    def test_scrubs_longer_secret_before_an_overlapping_secret(self):
        os.environ["E2E_WAF_BYPASS_TOKEN"] = "shared-prefix"
        os.environ["E2E_CLEANUP_SECRET"] = "shared-prefix-private-suffix"
        file = self.root / "network.trace"
        file.write_text("shared-prefix-private-suffix shared-prefix")
        self.assertEqual(scrubber.main([file]), 0)
        self.assertEqual(file.read_text(), "[scrubbed] [scrubbed]")

    def test_fails_closed_for_corrupt_archives(self):
        (self.root / "trace.zip").write_bytes(b"PKcorrupt")
        self.assertEqual(scrubber.main([self.root]), 1)

    def test_fails_closed_if_an_encoded_secret_survives(self):
        token = os.environ["E2E_CLEANUP_SECRET"].encode()
        (self.root / "results.json").write_bytes(base64.b64encode(token))
        self.assertEqual(scrubber.main([self.root]), 1)

    def test_no_secrets_is_a_noop(self):
        os.environ.pop("E2E_WAF_BYPASS_TOKEN")
        os.environ.pop("E2E_CLEANUP_SECRET")
        (self.root / "trace.zip").write_bytes(b"PKcorrupt")
        self.assertEqual(scrubber.main([self.root]), 0)


if __name__ == "__main__":
    unittest.main()
