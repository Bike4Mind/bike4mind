#!/usr/bin/env python3
"""Exercise source-built storage with the real Compose bucket initializer."""

import http.server
import json
from pathlib import Path
import secrets
import shlex
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parent.parent


def main():
    project = "objectstore-smoke-" + secrets.token_hex(4)
    events = []
    event_lock = threading.Lock()
    env_file = ROOT / ".env.selfhost"
    if not env_file.is_file():
        raise SystemExit("Configure .env.selfhost before running the storage smoke test")

    class Receiver(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            with event_lock:
                events.append((self.headers.get("Authorization"), payload))
            self.send_response(200)
            self.end_headers()

        def log_message(self, *_args):
            pass

    base_compose = [
        "docker", "compose", "-f", str(ROOT / "compose.selfhost.yaml"),
        "--env-file", str(env_file),
    ]
    base_config = json.loads(subprocess.run(
        [*base_compose, "config", "--format", "json"], cwd=ROOT,
        check=True, text=True, stdout=subprocess.PIPE, timeout=180,
    ).stdout)
    images = {
        service: base_config["services"][service].get("image")
        or f"{base_config['name']}-{service}"
        for service in ("minio", "createbuckets")
    }

    receiver = http.server.ThreadingHTTPServer(("0.0.0.0", 0), Receiver)
    threading.Thread(target=receiver.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory(prefix="objectstore-smoke-") as directory:
        override = Path(directory) / "compose.yaml"
        override.write_text(
            "services:\n  minio:\n"
            f"    image: {json.dumps(images['minio'])}\n    pull_policy: never\n    build: !reset null\n"
            "    ports: !reset []\n    extra_hosts:\n"
            "      - 'host.docker.internal:host-gateway'\n    environment:\n"
            "      MINIO_NOTIFY_WEBHOOK_ENDPOINT_primary: "
            f"http://host.docker.internal:{receiver.server_port}/events\n"
            "  createbuckets:\n"
            f"    image: {json.dumps(images['createbuckets'])}\n    pull_policy: never\n    build: !reset null\n"
        )
        compose = [
            "docker", "compose", "--project-name", project,
            "-f", str(ROOT / "compose.selfhost.yaml"), "-f", str(override),
            "--env-file", str(env_file),
        ]

        def run(*args, capture=False):
            return subprocess.run(
                [*compose, *args], cwd=ROOT, check=True, text=True,
                stdout=subprocess.PIPE if capture else None, timeout=180,
            ).stdout

        config = json.loads(run("config", "--format", "json", capture=True))
        environment = config["services"]["createbuckets"]["environment"]
        bucket_keys = [
            "APP_FILES_BUCKET", "EMAIL_INGESTION_BUCKET", "FAB_FILE_BUCKET",
            "GENERATED_IMAGES_BUCKET", "HISTORY_IMPORT_BUCKET",
            "PUBLISHED_ARTIFACTS_BUCKET", "SLACK_EXPORT_BUCKET",
        ]
        buckets = {key: environment[key] for key in bucket_keys}
        webhook_secret = config["services"]["minio"]["environment"]["MINIO_NOTIFY_WEBHOOK_AUTH_TOKEN_primary"]

        def mc(command, capture=False):
            return run(
                "run", "--rm", "--no-deps", "--pull", "never", "--entrypoint", "/bin/sh",
                "createbuckets", "-ec",
                'mc alias set local http://minio:9000 "$MINIO_ROOT_USER" '
                '"$MINIO_ROOT_PASSWORD" >/dev/null; ' + command,
                capture=capture,
            )

        try:
            for service, binary, timestamp, commit, toolchain in [
                ("minio", "minio", "2025-10-15T17-29-55Z",
                 "9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a", "go1.24.8"),
                ("createbuckets", "mc", "2025-08-13T08-35-41Z",
                 "7394ce0dd2a80935aded936b09fa12cbb3cb8096", "go1.23.10"),
            ]:
                version = run(
                    "run", "--rm", "--no-deps", "--pull", "never", "--entrypoint", "/bin/sh",
                    service, "-ec", f"{binary} --version; curl --version",
                    capture=True,
                )
                expected_version = f"{binary} version DEVELOPMENT.{timestamp} (commit-id={commit})"
                if expected_version not in version or f"Runtime: {toolchain} " not in version:
                    raise RuntimeError(f"Unexpected {binary} build metadata: {version}")
            run("up", "-d", "--no-build", "--wait", "--wait-timeout", "120", "minio")
            run("run", "--rm", "--no-deps", "--pull", "never", "createbuckets")
            run("run", "--rm", "--no-deps", "--pull", "never", "createbuckets")
            for bucket in buckets.values():
                mc("mc stat " + shlex.quote("local/" + bucket))
            for key, expected in [
                ("PUBLISHED_ARTIFACTS_BUCKET", {("drafts/", 7)}),
                ("HISTORY_IMPORT_BUCKET", {(None, 7)}),
                ("FAB_FILE_BUCKET", {("exports/", 1), ("generated-audio-offload/", 1)}),
            ]:
                lifecycle = json.loads(mc(
                    "mc ilm export " + shlex.quote("local/" + buckets[key]), capture=True,
                ))
                actual = set()
                for rule in lifecycle["Rules"]:
                    if rule.get("Status") == "Enabled":
                        prefix = rule.get("Filter", {}).get("Prefix") or rule.get("Prefix") or None
                        actual.add((prefix, rule.get("Expiration", {}).get("Days")))
                if not expected.issubset(actual):
                    raise RuntimeError(f"Missing lifecycle rules for {key}: {actual}")
            notified_buckets = [buckets["FAB_FILE_BUCKET"], buckets["HISTORY_IMPORT_BUCKET"]]
            for bucket in notified_buckets:
                target = shlex.quote("local/" + bucket + "/smoke.txt")
                result = mc(
                    "printf 'objectstore-smoke\\n' | mc pipe " + target
                    + " >/dev/null; mc cat " + target, capture=True,
                )
                if result != "objectstore-smoke\n":
                    raise RuntimeError(f"Object round trip failed for {bucket}")
            deadline = time.monotonic() + 30
            observed = set()
            while time.monotonic() < deadline:
                with event_lock:
                    snapshot = list(events)
                for authorization, payload in snapshot:
                    if authorization != "Bearer " + webhook_secret:
                        raise RuntimeError("Webhook authorization did not match the configured token")
                    for record in payload.get("Records", []):
                        if record["s3"]["object"]["key"] == "smoke.txt" and record["eventName"].startswith("s3:ObjectCreated:"):
                            observed.add(record["s3"]["bucket"]["name"])
                if set(notified_buckets).issubset(observed):
                    print("Storage smoke passed: releases, init, lifecycle, objects, authenticated notifications")
                    break
                time.sleep(0.25)
            else:
                raise RuntimeError(f"Missing object-created notifications for {set(notified_buckets) - observed}")
        except Exception:
            run("logs", "--no-color", "minio")
            raise
        finally:
            try:
                run("down", "--volumes", "--remove-orphans")
            finally:
                receiver.shutdown()
                receiver.server_close()


if __name__ == "__main__":
    main()
