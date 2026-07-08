#!/usr/bin/env python3
"""Open-core deploy guard: enforces parity between infra/deploy-contract.json and
the deploy-time env infra actually reads, so nothing infra depends on can reach
the (separate) deploy pipeline as an unknown.

infra/deploy-contract.json is the single, complete declaration of every env var
infra consumes at deploy time (infra/**/*.ts is SST config, evaluated at deploy):
  - builtImages:    images this repo's pipeline builds (Dockerfile -> ECR suffix
                    <app>-<name> -> the env the built URI is exported as)
  - externalImages: prebuilt image URIs the deployer supplies (env only)
  - deployEnv:      every other deploy-time env infra reads

The guard fails the PR when the contract and infra/ disagree, in the SAME PR that
changes either side. That is the general fix for the QuestProcessor->ChatCompletion
break: any new deploy-time dependency (a renamed image, a new required env) forces
the author to declare it here -- and the deployer reads this file to know what to
build and what it must supply -- instead of drifting silently until a deploy fails.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONTRACT = ROOT / "infra" / "deploy-contract.json"
INFRA_DIR = ROOT / "infra"
INFRA_ENV_RE = re.compile(r"process\.env\.([A-Z0-9_]+)")


def infra_env_reads():
    reads = set()
    for ts in INFRA_DIR.rglob("*.ts"):
        reads.update(INFRA_ENV_RE.findall(ts.read_text()))
    return reads


def main():
    if not CONTRACT.exists():
        # Refs predating adoption still deploy; the deployer falls back to
        # Dockerfile detection when the contract is absent.
        print(f"::notice::{CONTRACT.relative_to(ROOT)} absent -- skipping deploy contract check.")
        return 0

    try:
        data = json.loads(CONTRACT.read_text())
    except Exception as e:
        print(f"::error::Could not parse infra/deploy-contract.json: {e}")
        return 1

    errors = 0

    def err(msg):
        nonlocal errors
        print(f"::error::{msg}")
        errors += 1

    if data.get("schemaVersion") != 1:
        err(f"infra/deploy-contract.json schemaVersion must be 1 (got: {data.get('schemaVersion')!r}).")

    built = data.get("builtImages", [])
    external = data.get("externalImages", [])
    deploy_env = data.get("deployEnv", [])
    if not isinstance(built, list) or not isinstance(external, list) or not isinstance(deploy_env, list):
        print("::error::builtImages, externalImages, and deployEnv must all be arrays.")
        return 1

    declared = []  # every env the contract accounts for, with source label for messages
    for i, img in enumerate(built):
        for key in ("name", "dockerfile", "env"):
            if not isinstance(img.get(key), str) or not img[key]:
                err(f"builtImages[{i}] missing required string field '{key}'.")
        if isinstance(img.get("dockerfile"), str) and not (ROOT / img["dockerfile"]).exists():
            err(f"builtImages[{i}] dockerfile '{img['dockerfile']}' does not exist.")
        if isinstance(img.get("env"), str):
            declared.append(img["env"])
    for i, img in enumerate(external):
        if not isinstance(img.get("env"), str) or not img["env"]:
            err(f"externalImages[{i}] missing required string field 'env'.")
        else:
            declared.append(img["env"])
    for e in deploy_env:
        if not isinstance(e, str) or not e:
            err(f"deployEnv contains a non-string / empty entry: {e!r}.")
        else:
            declared.append(e)

    dupes = sorted({e for e in declared if declared.count(e) > 1})
    for e in dupes:
        err(f"env '{e}' is declared more than once across the contract buckets.")

    declared_set = set(declared)
    infra_set = infra_env_reads()

    for e in sorted(infra_set - declared_set):
        err(f"infra reads process.env.{e} at deploy time but it is not in "
            f"infra/deploy-contract.json (add it to deployEnv, or to builtImages/"
            f"externalImages if it is an image URI).")
    for e in sorted(declared_set - infra_set):
        err(f"infra/deploy-contract.json declares '{e}' but infra/ never reads it "
            f"(dead or renamed entry).")

    if errors:
        print(f"::error::deploy contract check failed with {errors} problem(s).")
        return 1

    print(f"deploy contract verified: {len(built)} built image(s), {len(external)} external image(s), "
          f"{len(deploy_env)} deploy env(s); parity with infra/ reads OK.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
