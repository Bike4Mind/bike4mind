# PR project selection

`project-selection.mjs` is the reviewed path-to-project policy. The selector runs
against the merge-base diff of immutable PR base and head SHAs. It selects whole
projects, never specs, and leaves Playwright setup dependencies enabled.

Every PR selection includes `unauthenticated`, `notebook`, and `prompts`.
Examples (before automatic setup dependencies):

| Diff | Selected projects |
| --- | --- |
| `app/components/Project/Card.tsx` | notebook, projects, prompts, unauthenticated |
| `e2e/teams-checkout.spec.ts` | notebook, prompts, teams, unauthenticated |
| `e2e/free-tier-limits.spec.ts` | credits, notebook, prompts, unauthenticated |
| shared layout, auth, API, routes, fixtures, helpers, manifests, lockfile, unknown path | full PR-eligible set |
| `e2e:full` label | full PR-eligible set |

The full PR set excludes `launch-readiness` and `referrals`, including projects
whose dependency closure would include them. Conditional suites stay opt-in;
the classification test loads all four combinations of `AI_LATENCY_RUN` and
`EXPORT_BYTES_RUN`. Standalone self-host specs have explicitly separate configs
and are outside this hosted selector. Every other spec/setup must match an
actual config regex, and every nondependency project must be classified.
Unknown classification or missing diff widens selection. Broken configuration
cannot be reported as a passing empty run.

## Preview execution

The Core workflow receives `workflow_dispatch` on `main` with `pr_number`.
It does not detect deployments through automatic status or label triggers.
The separate preview-rerun workflow and the Manual preview input explicitly
dispatch the same receiver. The `e2e:full` label affects selection only; it does
not start a run.

A PR number alone is not revision evidence. Preparation requires an open
same-repository PR, an exact deployed-head confirmation, a matching full revision
in the trusted bot's public deployment record, and deployed/not-stale labels.
Execution and reporting recheck the revision and status ID. Missing, ambiguous,
changed or unrecognized evidence fails closed without running tests or publishing
a passing result. HTTP health alone does not establish revision identity.

All installs, selector code, specs, configuration and reporting execute from the
trusted main dispatch commit. PR refs are fetched only as Git objects for the
path diff; they are never checked out or executed. New or modified PR specs are
therefore not executed until they reach main. The app under test is the PR's deployed head while
specs come from main, so a PR behind main can fail main's newer specs; rebase
and redeploy before reading a red result. Selection failures widen to the
full PR-eligible configuration from main.

The preview job has a 45-minute cap, a 15-minute Playwright timeout and a
17-minute execution-step ceiling that leaves time for failure reporting.
No preview is required for merging.
Results use a nonrequired `e2e/preview-advisory` status and advisory PR comment;
missing outputs use the reusable job result, never an assumed pass.

Scheduled runs in `e2e-manual.yml` remain full, including referrals and
launch-readiness. No schedule or promotion-gate scope is changed.

Local checks do not deploy a preview or invoke generation. This receiver must
reach main before dispatch integration can be exercised. A dispatch can arrive
before revision evidence is available; it will not retry or infer readiness.
The caller supplies no immutable revision, so a later fully verified deployment
may be observed instead of the deployment that originally requested the run.
