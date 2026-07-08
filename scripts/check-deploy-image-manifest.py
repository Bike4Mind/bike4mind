#!/usr/bin/env python3
"""Open-core deploy guard: keeps infra/images.json in lockstep with what infra
actually reads, so the deploy pipeline (a separate repo) never has to hardcode
app-specific build facts and silently drift out of sync.

infra/images.json is the source of truth for the images this repo's deploy
pipeline builds. Each entry maps a Dockerfile to the ECR repo suffix
(<app>-<name>) and to the env var the built image URI is exported as -- the same
env var infra reads. This check fails the PR that breaks that mapping, in the
same PR, instead of surfacing hours later as a cryptic deploy failure.

Externally-supplied images (prebuilt, handed in via CI vars, not built here) are
allowlisted below and intentionally have no manifest entry.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "infra" / "images.json"
INFRA_DIR = ROOT / "infra"
EXTERNAL_IMAGE_ENVS = {"SUBSCRIBER_FANOUT_IMAGE"}

# process.env.<NAME>_IMAGE reads only; the trailing boundary avoids matching
# GENERATED_IMAGES_BUCKET_NAME and the like.
INFRA_ENV_RE = re.compile(r"process\.env\.([A-Z0-9_]+_IMAGE)\b")


def infra_image_envs():
    envs = set()
    for ts in INFRA_DIR.rglob("*.ts"):
        envs.update(INFRA_ENV_RE.findall(ts.read_text()))
    return envs


def main():
    if not MANIFEST.exists():
        # Refs predating adoption still deploy; the deployer falls back to
        # Dockerfile detection when the manifest is absent.
        print(f"::notice::{MANIFEST.relative_to(ROOT)} absent -- skipping deploy image manifest check.")
        return 0

    try:
        data = json.loads(MANIFEST.read_text())
    except Exception as e:
        print(f"::error::Could not parse infra/images.json: {e}")
        return 1

    errors = 0

    def err(msg):
        nonlocal errors
        print(f"::error::{msg}")
        errors += 1

    if data.get("schemaVersion") != 1:
        err(f"infra/images.json schemaVersion must be 1 (got: {data.get('schemaVersion')!r}).")

    images = data.get("images")
    if not isinstance(images, list) or not images:
        print("::error::infra/images.json 'images' must be a non-empty array.")
        return 1

    seen_names, manifest_envs = set(), set()
    for i, img in enumerate(images):
        name, dockerfile, env = img.get("name"), img.get("dockerfile"), img.get("env")
        for key, val in (("name", name), ("dockerfile", dockerfile), ("env", env)):
            if not isinstance(val, str) or not val:
                err(f"images[{i}] missing required string field '{key}'.")
        if name in seen_names:
            err(f"images[{i}] duplicate name '{name}'.")
        if env in manifest_envs:
            err(f"images[{i}] duplicate env '{env}'.")
        seen_names.add(name)
        manifest_envs.add(env)
        if dockerfile and not (ROOT / dockerfile).exists():
            err(f"images[{i}] dockerfile '{dockerfile}' does not exist.")

    infra_envs = infra_image_envs()

    for env in sorted(manifest_envs):
        if env not in infra_envs:
            err(f"manifest env '{env}' is not read anywhere in infra/ (dead or renamed entry).")

    for env in sorted(infra_envs - EXTERNAL_IMAGE_ENVS - manifest_envs):
        err(f"infra reads built-image env '{env}' but it has no infra/images.json entry "
            f"(add one, or allowlist it in the guard if it is supplied prebuilt).")

    if errors:
        print(f"::error::deploy image manifest check failed with {errors} problem(s).")
        return 1

    for img in images:
        print(f"deploy image verified: {img['name']} <- {img['dockerfile']} -> {img['env']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
