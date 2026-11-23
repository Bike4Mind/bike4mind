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

The existing Core workflow consumes `preview/deploy` success status events.
The producer was verified via its completion workflow and observed GitHub
status API: it uses a GitHub App installation token, not the default workflow
token. It posts the status on the deployed SHA before settling the sticky
`preview-deployed` label. Status events cover redeploys that do not change labels.

Selection requires exactly one open same-repository PR at that SHA. Immediately
before tests, the runner checks the current head, latest status ID, App identity,
and deployed/not-stale labels again. Reporting repeats those checks and refuses
to publish stale results. HTTP health is an additional check, not SHA evidence.
Selection and execution check out the PR merge ref, so older PR heads inherit
the base's reporting scripts, selector and PR-eligible filter. Deployed-head
validation and QA attribution still use the original head SHA, not the merge ref.
The legacy `run-e2e` label and `e2e:full` label delegate to this same path, with a
45-minute job cap, a 15-minute Playwright timeout and a 17-minute execution-step
ceiling that leaves time for failure reporting. No preview is required for merging.
Results use a nonrequired `e2e/preview-advisory` status and advisory PR comment;
missing outputs use the reusable job result, never an assumed pass.

Scheduled runs in `e2e-manual.yml` remain full, including referrals and
launch-readiness. No schedule or promotion-gate scope is changed.

Local checks do not deploy a preview or invoke generation. The status trigger
becomes active only once its workflow is present on the default branch; verify
the first real post-merge deploy event operationally.
