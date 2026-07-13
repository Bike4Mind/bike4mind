# changes-filter

Composite action that decides whether a workflow run touched **deployable** paths,
and (independently) whether it touched the **docs site**. Use it to skip the
expensive test + deploy pipeline on docs-only / config-only changes. The
`docs-changed` output originally gated a Docusaurus build-verification job;
that job is removed for now (this repo tracks only docs-site markdown, not
the site scaffolding), so `docs-changed` is currently unconsumed.

Ported from `MillionOnMars/polaris` (PRs #4204 + #4540), adapted for lumina5:
docs live in `docs-site/` (not `docs/`), `.changeset/` is excluded, and a second
`docs-changed` output was added for the docs build gate.

## Outputs

| Output | Meaning |
|---|---|
| `deployable` | `'true'` to run test + deploy, `'false'` to skip. Fails **open** (`true`) when the diff range can't be resolved. |
| `docs-changed` | `'true'` when the changeset touches `docs-site/`. Fails **open** (`true`) on an unresolved range. Currently unconsumed. |

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
  range (no PR to scope to).
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

```

## Inputs

| Input | Default | Notes |
|---|---|---|
| `exclude-paths` | curated docs/config list | Newline-separated **git pathspecs**. If every changed file matches one, `deployable=false`. Blank lines and `#` comments ignored. |
| `docs-paths` | `docs-site/**` | INCLUDE-form pathspecs defining the docs site for `docs-changed`. |

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
