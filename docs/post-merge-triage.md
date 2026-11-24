# Post-merge full-suite triage

When explicitly enabled, `post-merge-triage.yml` observes failed `CI` pushes to main and the two scheduled
`E2E Tests (Manual)` full-suite runs. It does not dispatch tests, alter coverage,
merge PRs, close tracking on green, or use an LLM. Existing bot review remains
separate; it does not establish failure causality.

## Disabled-by-default staged rollout

Landing this workflow does not enable writes. Two repository Actions variables
require the exact lowercase string `true`:

- `POST_MERGE_TRIAGE_ENABLED`: enables automatic issue tracking and non-dry manual
  tracking. Unset, empty or any other value skips the write job.
- `POST_MERGE_REMEDIATION_ENABLED`: additionally required for confirmed non-dry
  draft remediation and App-token generation. It does not enable tracking alone.

No variables, App grants or secrets are changed by this implementation. Clearing
the tracking opt-in disables all write paths; clearing only the remediation
opt-in leaves tracking enabled but disables draft requests and their App token.
The planner also enforces both opt-ins before making any API calls for a write
request, even if called directly with a remediation client.

Manual `dry_run=true` remains available on main while disabled. Its separate job
has only actions/contents/issues read permissions, forces dry-run planning,
references no secrets and has no App-token step. `run_id` is sufficient for an
ordinary historical plan; reproduction and parent IDs are needed only when
requesting last-change confirmation. A rejected confirmation can fail the plan
but cannot publish a blocker, issue, branch, commit or PR in dry-run mode.

## Tracking and diagnostics

Each failed job/step signature gets a stable marker, following the existing
dependency-audit tracking pattern. All open issues are paginated, not just search
results. Subsequent runs append evidence to matching tracking; replaying the
same run attempt does not add a comment. Global non-cancelling concurrency
serializes writes. API errors fail the triage run instead of treating missing
tracking as an empty successful lookup.

The signature is workflow path + job name + failed step names, not a test-level
diagnosis. Several test failures can share one tracking issue. A maintainer can
route that signature to an existing issue by copying the tracking marker and
changing `post-merge-triage:` to `post-merge-known:`. Keep only one open issue for
each marker; reconcile any older duplicate manually. No fuzzy title matching is
used to guess that a failure is already known.

Issues link the exact run attempt, original job logs and retained artifacts.
They never copy job names, test output, logs, artifacts or secrets into issues.
GitHub's original retention still applies: this automation does not archive logs
or extend artifact lifetimes. Preserve necessary evidence in approved storage
before it expires.

- A recognized failed install/checkout/health step is classified as setup.
- A successful full rerun after a failed attempt is intermittent, not proven flaky.
- Other failures are uncertain until the test-level comparison is reviewed.
- Scheduled E2E tests staging: its workflow head is **not** proof of the deployed
  SHA. Consult existing QA ingest and the run's tested-SHA evidence. This path
  deliberately cannot automatically revert E2E failures.

The next diagnostic is recorded explicitly; nothing claims resolved or verified.
Unrecognized setup steps remain uncertain, not product regressions. Test names
and failure messages are inspected by a maintainer at their original run links,
not parsed from privileged downloaded artifacts.

## Confirmed last-change draft remediation

A maintainer with workflow-dispatch access may use **Actions > Post-merge failure
triage > Run workflow**, on **main**, with:

1. `run_id`: the failed full main CI run.
2. `reproduction_run_id`: an independent full main CI failure on the same SHA
   (a later failed attempt of the same run is allowed).
3. `parent_run_id`: successful full main CI on its direct parent.
4. `confirmed_last_change`: only after inspecting the same failing test on head,
   verifying it passes on parent, and reviewing the change for safe reversal.
5. Leave `dry_run` true first. Inspect the triage job's classification.
6. Repeat with `dry_run` false only after confirming the evidence and explicitly
   enabling both repository rollout opt-ins through the approved rollout process.

Repeated failed jobs plus a green parent alone do **not** prove causality; the
maintainer attestation is essential. No run is dispatched automatically.

The deterministic candidate is limited to an unchanged main tip with one parent
and fewer than 300 modified application/core/package JS/TS source files. Added,
removed, renamed, test, fixture, migration, auth/security and non-source changes
are refused. Paginated commit file responses are refused rather than assuming
the first page is the entire change; hitting the file cap also blocks.
The API creates a child commit whose tree equals the direct parent's tree, then
opens a **draft** PR. No candidate code is checked out or executed. Existing
candidate branches are validated; existing PRs, including closed ones, are not
recreated. Other fixes/reverts require a human's normal development workflow.

Prerequisites for writes are Actions/issues permission and, only for confirmed
draft creation, the existing `RELEASE_APP_ID` / `RELEASE_APP_PRIVATE_KEY` App
with contents and pull-request write access. This uses the audit autofix App
pattern so the resulting PR can receive normal CI. There is no fallback token.
App-token setup errors still allow tracking to record the missing-token blocker.
Draft API errors append an explicit blocker to tracking.
Draft creation does not run verification, mark ready, merge, or close the issue.
Current draft CI can skip expensive jobs: a human must mark ready and obtain
full required checks and full E2E evidence before deciding to merge.

## Trust boundary and rollout

The privileged completion handler checks out main with credentials disabled,
never the event head, PR code, or artifacts. It re-fetches authoritative run
metadata and validates the exact workflow path/name, same repository, main
branch, push/schedule event, completed state, SHA syntax and main ancestry.
Stale attempt events fail closed. The job has no contents-write permission;
the scoped App token is generated only for an explicit non-dry confirmed dispatch.
No arbitrary commands, AI text or run logs are evaluated.

Focused verification:

```sh
VITEST_MAX_WORKERS=25% pnpm exec vitest run scripts/__tests__/post-merge-triage.test.mjs
pnpm exec eslint scripts/post-merge-triage.mjs scripts/__tests__/post-merge-triage.test.mjs
actionlint .github/workflows/post-merge-triage.yml
```

Older actionlint action catalogs may report that `create-github-app-token@v3`
requires `app-id` and does not support `client-id`. The published v3 action
contract supports `client-id`; update the catalog or suppress only those two
catalog diagnostics, not workflow syntax or expression checks.

Mocked tests cover representative failed runs, passing/recovered runs, setup,
known failures, deduplication, trust rejection, draft API behavior and blockers.
They make no live GitHub writes. **This is not live operational proof.** The
workflow can land disabled without claiming the live failure path is operational.
After landing, follow these stages:

1. Leave both variables unset. Dispatch on main with `run_id` from a naturally
   failed eligible historical run and `dry_run=true`. Confirm classification,
   original-run eligibility and no issue/PR/branch writes or App-token step.
2. Review App grants and tracking permissions through the approved process.
   Explicitly opt in to tracking only when authorized; do not enable remediation.
3. Inspect the next naturally failed eligible full run and its tracking. Replay
   that event's evidence with an authorized non-dry tracking dispatch and confirm
   the original issue is reused without duplicate evidence. Do not manufacture
   failures or dispatch a failing full suite for validation.
4. Keep remediation disabled until a real incident has reviewed head/parent
   test-level evidence and an authorized operator approves the App grants and
   remediation opt-in. Use dry-run confirmation first. Never create a real draft
   merely to test credentials; the first authorized real remediation remains
   draft pending normal full checks and human review.

Until each stage is evidenced, its operational claim remains unverified. Missing
causality is a blocker, never green. No stage authorizes an automatic merge.

Read-only pre-landing inspection validated the API metadata and main ancestry of
[a historical main CI failure](https://github.com/Bike4Mind/bike4mind/actions/runs/45112287572)
and [a scheduled full E2E failure](https://github.com/Bike4Mind/bike4mind/actions/runs/45098561238).
The local planner classified their three and one failed jobs respectively as
uncertain/blocked. Only metadata GET requests were made, without reading logs or
dispatching workflows. This supports eligibility assumptions, not live workflow
delivery, token grants, tracking deduplication or remediation readiness.

GitHub concurrency serializes writes but retains only one pending run per group:
bursts can replace an older pending triage invocation. Original CI/E2E runs remain
red and retain their evidence. Operators must reconcile any missed failures from
the Actions history (a default dry-run dispatch can inspect a historical run).
This observer is not a guaranteed-delivery incident queue.
