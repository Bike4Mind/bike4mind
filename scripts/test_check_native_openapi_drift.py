import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCRIPT = REPO / "scripts/check_native_openapi_drift.py"
IOS = "apps/ios/Packages/B4MClient"
ANDROID = "apps/android/client"
STRIP = {IOS: f"{IOS}/Scripts/strip_overlay_literals.py", ANDROID: f"{ANDROID}/scripts/strip_overlay_literals.py"}
SPEC = {"openapi": "3.0.0", "paths": {"/a": {"get": {"summary": "a"}}}, "components": {"schemas": {"A": {"properties": {"x": {}}}}}}


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


class DriftCheckTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)
        (self.root / "scripts").mkdir()
        shutil.copy(REPO / "scripts/check-no-overlay-literals.sh", self.root / "scripts")
        for client, strip in STRIP.items():
            (self.root / strip).parent.mkdir(parents=True)
            shutil.copy(REPO / strip, self.root / strip)
            write_json(self.root / client / "openapi.json", SPEC)
        write_json(self.root / "apps/client/public/openapi.json", SPEC)

    def run_check(self):
        result = subprocess.run(
            [sys.executable, "-I", str(SCRIPT), "--repo-root", str(self.root)], capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_matching_snapshots_are_in_sync(self):
        report = self.run_check()
        self.assertIn("Every native client snapshot matches", report)
        self.assertNotIn("drifted", report)

    def test_server_change_is_reported_per_client(self):
        write_json(self.root / "apps/client/public/openapi.json", {**SPEC, "paths": {**SPEC["paths"], "/b": {"post": {}}}})
        report = self.run_check()
        self.assertIn("iOS (drifted)", report)
        self.assertIn("Android (drifted)", report)
        self.assertIn("`POST /b`", report)

    def test_only_the_stale_client_is_reported(self):
        write_json(self.root / ANDROID / "openapi.json", {**SPEC, "paths": {}})
        report = self.run_check()
        self.assertIn("iOS (in-sync)", report)
        self.assertIn("Android (drifted)", report)

    def test_absent_client_is_skipped(self):
        shutil.rmtree(self.root / "apps/android")
        report = self.run_check()
        self.assertIn("Android (skipped)", report)
        self.assertIn("iOS (in-sync)", report)

    def test_missing_server_spec_exits_2(self):
        result = subprocess.run(
            [sys.executable, "-I", str(SCRIPT), "--repo-root", str(self.root), "--server-spec", str(self.root / "nope")],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 2)


if __name__ == "__main__":
    unittest.main()
