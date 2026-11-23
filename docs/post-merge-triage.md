# Post-merge full-suite triage

`post-merge-triage.yml` observes failed `CI` pushes to main and the two scheduled
`E2E Tests (Manual)` full-suite runs. It does not dispatch tests, alter coverage,
merge PRs, close tracking on green, or use an LLM. Existing bot review remains
separate; it does not establish failure causality.

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
6. Repeat with `dry_run` false only after confirming the evidence.

Repeated failed jobs plus a green parent alone do **not** prove causality; the
maintainer attestation is essential. No run is dispatched automatically.

The deterministic candidate is limited to an unchanged main tip with one parent
and fewer than 300 modified application/core/package JS/TS source files. Added,
removed, renamed, test, fixture, migration, auth/security and non-source changes
are refused. The original commit file list is bounded; hitting its cap blocks.
The API creates a child commit whose tree equals the direct parent's tree, then
opens a **draft** PR. No candidate code is checked out or executed. Existing
candidate branches are validated; existing PRs, including closed ones, are not
recreated. Other fixes/reverts require a human's normal development workflow.

Prerequisites for writes are Actions/issues permission and, only for confirmed
draft creation, the existing `RELEASE_APP_ID` / `RELEASE_APP_PRIVATE_KEY` App
with contents and pull-request write access. This uses the audit autofix App
pattern so the resulting PR can receive normal CI. There is no fallback token.
App-token setup errors leave a failed triage run; initial automatic failure
tracking remains open. Draft API errors append an explicit blocker to tracking.
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
They make no live GitHub writes. **This is not live operational proof.** After
landing, a maintainer must inspect a naturally failed eligible full run and its
tracking, verify a repeated event reuses it, then use a read-only dry-run dispatch
with reviewed historical CI evidence. Confirm App grants before an authorized
real draft request. Do not intentionally dispatch a failing full suite or create
a live revert just to test this automation. Until this is done, rollout remains
pending operational validation; missing causality is a blocker, never green.
