# changes-filter

Composite action that decides whether a workflow run touched **deployable** paths,
and (independently) whether it touched the **docs site**. Use it to skip the
expensive test + deploy pipeline on docs-only / config-only changes. The
`docs-changed` output originally gated a Docusaurus build-verification job;
that job is removed for now (this repo tracks only docs-site markdown, not
the site scaffolding). It now gates the `help-docs` job in `ci.yml`, which runs
the help guards that a docs-only (non-deployable) run would otherwise skip.

Ported from `MillionOnMars/polaris` (PRs #4204 + #4540), adapted for lumina5:
docs live in `docs-site/` (not `docs/`), `.changeset/` is excluded, and a second
`docs-changed` output was added for the docs build gate.

## Outputs

| Output | Meaning |
|---|---|
| `deployable` | `'true'` to run test + deploy, `'false'` to skip. Fails **open** (`true`) when the diff range can't be resolved. |
| `docs-changed` | `'true'` when the changeset touches `docs-site/` or the help tooling in `packages/scripts/help/`. Fails **open** (`true`) on an unresolved range. Gates the `help-docs` job. |

The two are orthogonal: a docs-only PR is `deployable=false, docs-changed=true`;
a code+docs PR is `true, true`; a `.changeset` or root-`README` change is
`false, false`.

## Why this and not `paths-ignore` / a marketplace action

- **Per-PR, not per-push.** GitHub `paths-ignore` (and `dorny/paths-filter`'s PR
  mode) match the *whole PR diff vs base*; a workflow-level `paths-ignore` also
  skips the entire workflow, so a required `CI Complete`/`Run Tests` context never
  reports and the PR hangs. Here the `changes` gate job always runs and downstream
  jobs skip via `if:`, which branch protection counts as passing.
- **Merge-base scoped (per #4540).** On every `pull_request` action the diff is the
  whole PR vs `git merge-base(base, head)` — the three-dot "Files changed"
  semantics — not the per-push `before..after` range. Without this, a synchronize
  that also merges/rebases `main` in would carry all of main's deployable files and
  force a spurious deploy of a docs-only PR. `push` to main/prod keeps the per-push
  range (no PR to scope to), and `merge_group` uses the queue entry's own
  `base_sha..head_sha`, which is that entry's own change rather than the whole batch:
  `base_sha` is the commit the entry was built on (the target-branch tip, or the
  previous entry's speculative head in a stacked group), so each queue entry is gated on
  exactly the diff its own PR CI evaluated. That also makes `base_sha` an ancestor of
  `head_sha`, so two-dot already equals three-dot there and no `merge-base` call is needed.
- **No third-party trust surface.** ~40 lines of `git diff`; nothing to SHA-pin or
  audit (cf. the 2025 `tj-actions/changed-files` supply-chain incident).

## Usage

The caller **must** check out the repo first with `fetch-depth: 0` (merge-base
needs full history).

```yaml
jobs:
  changes:
    runs-on: ubuntu-latest
    outputs:
      deployable: ${{ steps.filter.outputs.deployable }}
      docs-changed: ${{ steps.filter.outputs.docs-changed }}
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - id: filter
        uses: ./.github/actions/changes-filter

  core-build:
    needs: changes
    if: needs.changes.outputs.deployable == 'true'
    ...

  help-docs:
    needs: [changes, core-build]
    if: |
      !cancelled() &&
      needs.changes.outputs.docs-changed == 'true' &&
      needs.core-build.result != 'failure'
    steps:
      ...
      - id: download-core
        uses: actions/download-artifact@v7
        with:
          name: core-build-${{ needs.core-build.outputs.core-content-hash }}
        continue-on-error: true
      - if: steps.download-core.outcome == 'failure'
        run: pnpm core:build
      ...

```

`help-docs` is the shape to copy for any job gated on `docs-changed` that also needs the
core packages built. `core-build` is gated on `deployable`, so on a docs-only PR it skips;
a plain `needs: core-build` would make this job inherit that skip and go quiet on exactly
the changes it exists to guard. A status-check function in the `if` is what lifts the
implicit `success()` on `needs` and lets a skipped `core-build` through - use `!cancelled()`
rather than `always()`, which also survives run cancellation and would keep an expensive job
on a runner after a superseded push. `needs.core-build.result != 'failure'` then does the
real gating, and admits a `cancelled` core-build (runner loss), which the fallback covers.
Keep the block scalar: a bare `if: !cancelled() && ...` is a YAML tag indicator, not text.

With `core-build` skipped the artifact name interpolates to the literal `core-build-`,
so the download fails; `continue-on-error: true` plus the `outcome == 'failure'` fallback
is what turns that into a local build instead of a red leg. That pairing is enforced by
`packages/scripts/src/checkHelpDocsJobWired.test.ts` for every job written this way.

## Inputs

| Input | Default | Notes |
|---|---|---|
| `exclude-paths` | curated docs/config list | Newline-separated **git pathspecs**. If every changed file matches one, `deployable=false`. Blank lines and `#` comments ignored. |
| `docs-paths` | `docs-site/**`, `packages/scripts/help/**` | INCLUDE-form pathspecs defining the docs site for `docs-changed`. Includes the help tooling, so a change to those scripts runs the `help-docs` guard that covers them. |

## Gotchas baked into the default list

- Use `:(glob)` magic so `**` means "any depth" and `*` stops at `/`. Default
  pathspec magic does **not** exclude a root `README.md` via `:(exclude)**/*.md`.
- Do **not** blanket-exclude `**/*.md`. Some markdown is a runtime build input
  (`@next/mdx`, `app/prompts/*.md`, `app/content/*.md`); the default only excludes
  markdown in docs locations (READMEs, `docs-site/`, `agents/`, repo root).
- `.github/actions/changes-filter/**` is **intentionally not** excluded — a PR that
  edits only this action still runs the full pipeline, so the change is exercised
  end-to-end before it ships.

## Fail-open posture

Every uncertain state resolves to "deploy + build docs": unresolved diff range
(new branch, force-push, all-zero before-SHA, missing/failed merge-base) or a
`git diff` that errors after range validation → `deployable=true`,
`docs-changed=true`. A `changes` job that crashed without writing outputs would
look identical to a skip to the downstream `if:` checks, so failing open trades one
unnecessary deploy for never silently dropping one.

That posture only holds for a *one-off* unresolved range. An event with no arm in the
action's `case "$EVENT_NAME"` block fails open on **every** run of that trigger, and
the run looks entirely normal - nothing errors, some extra jobs just run. That is what
`merge_group` did before it was handled: the merge queue evaluated
`deployable=true, docs-changed=true` unconditionally and so gated on a different signal
than the PR's own CI, which lets a queue run fail a leg the PR legitimately skipped.
`packages/scripts/src/checkChangesFilterEvents.test.ts` therefore cross-checks `ci.yml`'s
trigger list against the arms, and checks that each arm's SHAs are declared in the
step's `env:` block, bound to that event's own payload, and bound to the end of the range
their names claim (an arm alone reads unset vars and fails open identically; a base bound
to a head fails closed, which is worse - the diff is empty and the legs the gate should
trigger are skipped instead). Letting an event fail open on purpose is fine - write the arm
explicitly (`BASE=""; HEAD=""`) so the choice is visible rather than inherited.
