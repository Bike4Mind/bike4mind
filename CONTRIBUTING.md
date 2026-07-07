# Contributing to Bike4Mind

Thank you for your interest in contributing! Bike4Mind is an **open-core** project: the source in this repository is publicly available under the [Business Source License 1.1](./LICENSE) so you can read it, run it, self-host it, and improve it — while Bike4Mind, Inc. operates the hosted service at [app.bike4mind.com](https://app.bike4mind.com).

This document explains everything you need to know to get a change from idea to merged PR. Please read it before opening your first pull request — PRs that follow this guide get reviewed and merged much faster.

## Table of Contents

- [How the project is licensed (and why it matters to you)](#how-the-project-is-licensed-and-why-it-matters-to-you)
- [Contributor License Agreement (CLA)](#contributor-license-agreement-cla)
- [Code of Conduct](#code-of-conduct)
- [Ways to contribute](#ways-to-contribute)
- [Before you write code: issue-first](#before-you-write-code-issue-first)
- [The open/closed boundary](#the-openclosed-boundary)
- [Development setup](#development-setup)
- [Project structure](#project-structure)
- [Engineering standards](#engineering-standards)
- [Git workflow: fork → branch → PR](#git-workflow-fork--branch--pr)
- [Pull request requirements](#pull-request-requirements)
- [CI: the checks your PR must pass](#ci-the-checks-your-pr-must-pass)
- [The review process](#the-review-process)
- [Reporting security vulnerabilities](#reporting-security-vulnerabilities)
- [Reporting bugs](#reporting-bugs)
- [Questions and community](#questions-and-community)

## How the project is licensed (and why it matters to you)

The repository is licensed under the **Business Source License 1.1 (BUSL-1.1)** with a broad Additional Use Grant:

- ✅ You **may** read, modify, redistribute, and make production use of the code — including self-hosting it on your own infrastructure for your organization's internal use, and building/commercializing your own products on top of it.
- ❌ You **may not** offer the software to third parties as a competing hosted/managed service (a "Bike4Mind Service" as defined in the [LICENSE](./LICENSE)).
- 🕓 Each released version **automatically converts to Apache-2.0** two years after its public release.
- 🙏 If you fork or build on it, you're **encouraged** (not required, during the source-available window) to keep the [NOTICE](./NOTICE) and say your product is "built on Bike4Mind." You may use the name for that accurate, nominative purpose — just not as your own product name or in a way that implies endorsement. Once a version converts to Apache-2.0, keeping the NOTICE when you distribute that version becomes required (Apache §4(d)) — the obligation attaches to distribution, not to hosted use.

This license will never be tightened. For alternative licensing arrangements, contact **licensing@bike4mind.com**.

## Contributor License Agreement (CLA)

Because each version of the code converts to Apache-2.0 on its Change Date, Bike4Mind, Inc. must hold sufficient rights to every contribution to perform that relicense. For that reason, **all contributors must sign our CLA before their first PR can merge**.

- Signing is a one-time, automated step: the CLA bot will comment on your first PR with instructions, and signing is done by replying to the bot / clicking through — no paperwork.
- The CLA grants Bike4Mind, Inc. the right to distribute your contribution under the repository license (including the scheduled Apache-2.0 conversion). **You retain copyright** to your work.
- PRs cannot merge until the CLA check passes.

If you are contributing on behalf of your employer, make sure you are authorized to sign, or ask us about a corporate CLA.

## Code of Conduct

We follow the [Contributor Covenant](https://www.contributor-covenant.org/) — see [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md). In short: be respectful, be constructive, assume good faith, and keep discussions focused on the work. Report unacceptable behavior through the contact listed in the Code of Conduct.

## Ways to contribute

You don't have to write code to contribute meaningfully:

- **Bug reports** — a precise, reproducible bug report is one of the most valuable contributions there is. See [Reporting bugs](#reporting-bugs).
- **Documentation** — fixes and improvements to `docs-site/` (Docusaurus) and inline docs are always welcome and are a great first contribution.
- **Bug fixes** — look for issues labeled `good first issue` or `help wanted`.
- **Features** — welcome, but **discuss first** (see below). Unsolicited large feature PRs are the most likely category to be declined.
- **Tests** — improving coverage on under-tested areas is always appreciated.
- **Self-hosting feedback** — reports about rough edges in the self-host experience directly improve the project's most important on-ramp.

## Before you write code: issue-first

For anything larger than a trivial fix (typo, obvious one-line bug, doc correction):

1. **Search existing issues** to see if it's already tracked or being worked on.
2. **Open an issue first** describing the problem and your proposed approach.
3. **Wait for a maintainer to confirm direction** before investing significant effort.

This protects your time. The most painful outcome for everyone is a large, well-crafted PR that must be declined because it conflicts with in-flight work, crosses the open/closed boundary, or takes an approach the maintainers can't own long-term. A short issue discussion up front prevents that.

Maintainers triage issues with priority labels `P0` (critical) through `P3` (nice-to-have); these indicate how we stack-rank our own effort, not whether community PRs are welcome — a well-made PR for a `P3` issue is still a welcome PR.

## The open/closed boundary

Bike4Mind is open-core. The agent engine, LLM adapters, CLI, data models, and self-hosting paths are open and are the primary surface for community contribution. Operating the multi-tenant hosted service (billing, entitlements enforcement, hosted infrastructure and deployment) is Bike4Mind, Inc.'s business, and features in that area are driven by the core team.

Practical guidance:

- Contributions that improve the **engine, adapters, CLI, self-host experience, docs, tests, and developer experience** are the sweet spot.
- PRs that add **new third-party paid-service dependencies**, alter **billing/entitlement mechanics**, or change **hosted-deployment infrastructure** need explicit maintainer sign-off in an issue before you start.
- When in doubt, ask in an issue — "is this in scope for a community PR?" is always a fine question.

## Development setup

### Prerequisites

- **Git**
- **Node.js 24.x** (see `.nvmrc` — use `nvm use`)
- **pnpm** (`npm install -g pnpm`)
- **Docker** (for running MongoDB locally via `compose.yaml`)
- **Gitleaks** (`brew install gitleaks` / your package manager) — used by the pre-commit hook

### Install, build, verify

```bash
# 1. Fork the repo on GitHub, then:
git clone git@github.com:<your-username>/<repo>.git
cd <repo>
git remote add upstream git@github.com:<upstream-org>/<repo>.git

# 2. Install dependencies (all workspaces)
pnpm i -r

# 3. Install the git hooks (gitleaks secret scan + lint-staged)
./install-hooks.sh

# 4. Build the core packages (dependency-ordered, cached)
pnpm turbo:core:build

# 5. Verify your environment works before changing anything
pnpm turbo:typecheck   # TypeScript across all packages
pnpm turbo:test        # all test suites (MongoDB tests use mongodb-memory-server — no local DB needed)
pnpm lint:check        # ESLint, error severity only (mirrors the CI gate)
```

If all three pass on a clean checkout, you're ready. **Most contributions can be fully developed and validated with just typecheck + tests + lint** — you do not need AWS access or a running full stack to fix a bug in the engine, adapters, or data models.

To run the application locally (needed for UI work), see the [README](./README.md) local development setup and the self-hosting documentation. `compose.yaml` provides a local MongoDB replica set (`docker compose up db`).

### Useful commands

| Task | Command | Notes |
|---|---|---|
| Typecheck (fast) | `pnpm turbo:typecheck` | Cached; falls back to `pnpm -r typecheck` |
| Run all tests | `pnpm turbo:test` | Parallel across packages |
| Test one package | `pnpm --filter <package> test` | e.g. `pnpm --filter @bike4mind/agents test` |
| Lint | `pnpm lint:check` | Mirrors CI |
| Build core packages | `pnpm turbo:core:build` | Add `--force` if builds seem stale |
| Docs preview | `cd docs-site && pnpm start` | http://localhost:3010 |

⚠️ Do **not** run unfiltered `turbo build` — it attempts to build the SST-managed apps outside their deploy context and will fail.

If you see unexpected type errors after pulling from `main`, rebuild: `pnpm i -r && pnpm turbo:core:build`.

## Project structure

```
├── apps/
│   ├── client/              # Next.js app — SPA (Tanstack Router) + API routes (Next.js pages API)
│   │   └── server/          # Backend service code behind the API routes
│   ├── cli/                 # B4M CLI — edge agent
│   └── subscriber-fanout/   # Real-time WebSocket fanout
├── b4m-core/@bike4mind/*    # The core engine — published npm packages
│   ├── agents/ services/ utils/ common/   # Agent framework
│   ├── llm-adapters/        # Anthropic, OpenAI, Gemini, X.ai, Ollama adapters
│   └── mcp/ slack/ voice/ optihashi/ ...    # Capabilities
├── packages/
│   ├── database/            # Mongoose models & migrations
│   ├── typescript-config/   # Shared tsconfig
│   └── eslint-config/       # Shared ESLint config
├── docs-site/               # Docusaurus documentation site
└── infra/                   # SST/AWS infrastructure for the hosted service
```

Build order for core packages: `common → utils → agents → services → slack` (handled automatically by `pnpm turbo:core:build`).

## Engineering standards

These are enforced in review; the full rationale for each lives in [CLAUDE.md](./CLAUDE.md) (our in-repo engineering standards document — it's written for AI coding agents, but the rules apply to everyone).

**TypeScript**
- Avoid `any`. Prefer `unknown` + narrowing, generics, or union types. If `any` is truly unavoidable, add a comment justifying it.

**Frontend**
- **MUI Joy** (`@mui/joy`) is the UI library. Do not add or use `@emotion` directly.
- **Tanstack Router** for all client-side routing. Never use Next.js router hooks — Next.js exists only for the pages API backend.
- For theme mode checks use `useTheme().palette.mode`, not `useColorScheme()` (which can return `'system'`).

**Database (Mongoose)**
- Never use `index: true` on field definitions. Declare all performance indexes together via `schema.index()` at the bottom of the schema file. `unique: true` on a field is fine (it's a data constraint).

**Testing**
- Co-locate tests next to source files (`Foo.tsx` → `Foo.test.tsx`). Exception: files under `pages/` use a `__tests__/` subdirectory.
- Select elements with `data-testid` (`component-action-element` naming), never CSS class names.
- MUI Joy component tests need the theme wrapper (see CLAUDE.md → Testing Guidelines for the snippet).
- New database tests must use `createMongoServer()` from `packages/database/src/__test__/createMongoServer.ts` instead of `MongoMemoryServer.create()` (avoids parallel-run port races).
- **New behavior needs tests.** Bug-fix PRs should include a test that fails without the fix.

**Documentation**
- User-facing features and API changes should update `docs-site/docs/` (Docusaurus markdown with frontmatter). Beware MDX escaping — a bare `<` followed by text breaks the build.

## Git workflow: fork → branch → PR

External contributions come in via the standard GitHub fork model. Direct pushes to this repository are restricted to maintainers, and **nobody** — maintainers included — pushes directly to `main`; every change lands through a reviewed PR.

1. **Fork** the repository to your own account.
2. **Keep your fork's `main` in sync** with upstream (`git fetch upstream && git rebase upstream/main` on your local main, or use GitHub's "Sync fork").
3. **Create a topic branch off `main`** in your fork. Branch naming: `type/short-description` — e.g. `fix/questmaster-spinner`, `feat/ollama-streaming`, `docs/self-host-guide`.
4. **Make focused commits** in [Conventional Commits](https://www.conventionalcommits.org/) format: `type(scope): description` — e.g. `fix(llm-adapters): handle empty stream chunks from Ollama`. Individual commit messages are squashed away on merge, but clean commits make review easier.
5. **One concern per PR.** A PR that fixes a bug *and* refactors an unrelated module *and* reformats files will be asked to split. Small, focused PRs merge fast; sprawling ones stall.
6. **Never commit secrets.** The gitleaks pre-commit hook and CI scans enforce this, but treat them as a backstop, not the guard.
7. **Push to your fork** and open a PR against `main`.

We **squash-merge** all PRs: your PR becomes exactly one commit on `main`, and **the PR title becomes the commit message** — which is why the PR title format is a blocking CI check (see below).

## Pull request requirements

### PR title — Conventional Commits (enforced by CI)

Your PR title must be a valid conventional commit header. Allowed types:

```
feat | fix | docs | style | refactor | perf | test | build | ci | chore
```

Examples: `feat(cli): add --offline flag`, `fix(database): dedupe quest index`, `docs: clarify self-host env vars`. A scope is encouraged but optional. Breaking changes use the `!` suffix: `feat(agents)!: change tool registration API`.

The title matters beyond cosmetics: **changesets (package version bumps) are auto-generated from the PR title.** `feat` → minor bump, `fix`/`perf`/`refactor` → patch, `!` → major, `chore`/`docs`/`test`/`ci`/`build`/`style` → no release. You do not need to run `pnpm changeset` manually unless you need to override the default (e.g. different bump types per package).

### PR description — follow the template

The [PR template](./.github/pull_request_template.md) is not decoration; fill in every applicable section:

- **Description** — what problem this solves and why this approach. Link the issue it addresses (`Closes #123`).
- **Changes** — a bulleted list of what changed, for reviewers.
- **Guide for Testers** — numbered, step-by-step manual verification instructions that someone *without codebase knowledge* can follow. One action per step, exact navigation paths and input values, expected result after each step. For API-only changes, provide re-runnable `curl` commands with expected responses. Do **not** write "run the tests" here — automated tests belong in CI, this section is for hands-on verification.
- **Screenshots/video** — required for any UI change.
- **Checklist** — actually do the items, don't just tick them.

### Scope hygiene

- No drive-by reformatting or mass renames mixed into functional changes.
- Match the style of surrounding code (comment density, naming, idiom).
- Keep dependencies scoped: add new dependencies to the specific workspace package that uses them, not the root `package.json`. New runtime dependencies need justification in the PR description.

## CI: the checks your PR must pass

All of these are required and blocking:

| Check | What it verifies | Run it locally |
|---|---|---|
| **Semantic PR Title** | PR title is a valid conventional commit | — (fix the title) |
| **Typecheck** | TypeScript across all packages | `pnpm turbo:typecheck` |
| **Lint** | ESLint error-severity violations | `pnpm lint:check` |
| **Run Tests** | Full test suite (sharded in CI) | `pnpm turbo:test` |
| **Secret scan** | No credentials in the diff | gitleaks pre-commit hook |
| **Semgrep** | Static security analysis | — |
| **CLA** | You've signed the CLA | one-time, via bot |

Run typecheck, lint, and tests locally before pushing — it's dramatically faster than round-tripping through CI.

Two notes specific to fork PRs:

- CI for first-time contributors requires a maintainer to approve the workflow run — this is standard GitHub security, not a judgment on your PR. It happens quickly after triage.
- Some internal automation (e.g. the AI review bot) doesn't run on fork PRs because it requires repository secrets. Maintainers will run those stages after initial review where relevant. Preview environments are unaffected by fork status — see below — since a maintainer triggers them out-of-band from an internal pipeline.

### Preview deploys

Preview environments (`pr<N>.preview.bike4mind.com`) are created **on demand by maintainers** through an internal deploy pipeline — there is no label or comment command on this repo that triggers one. Every PR still runs the full CI suite (typecheck, lint, tests). When a maintainer wants to exercise your change in a live environment, they trigger a preview and a bot comment with the URL appears on the PR; previews are torn down automatically when the PR closes or after 3 days without a redeploy. The required **Deploy** check stays green either way — the absence of a preview is expected, not a failure.

## The review process

1. **Automated checks run first.** Get them green — maintainers generally review PRs with passing checks before ones without.
2. **A maintainer reviews** for correctness, design fit, boundary fit, test coverage, and maintainability. Review is prioritized by issue priority (P0 → P3) and PR readiness; small, focused, well-tested PRs are the fastest path through the queue. Review capacity for community PRs is best-effort — a supportive ping after a period of silence is welcome; opening duplicate PRs is not.
3. **Respond to feedback with new commits** (don't force-push over the review history; we squash at merge anyway). Mark conversations resolved as you address them — all conversations must be resolved before merge.
4. **Stale PRs**: PRs with unaddressed feedback and no activity get labeled stale and eventually closed by automation. Closing isn't rejection — you can reopen when you have bandwidth.
5. **A maintainer merges** (squash) once approved and green. Your change ships to the hosted platform through our normal release pipeline, and to self-hosters in the next tagged release.

What gets PRs declined most often, in order: (1) no prior issue/discussion for a large change, (2) crossing the open/closed boundary, (3) missing tests, (4) scope sprawl, (5) new heavyweight dependencies without justification.

## Reporting security vulnerabilities

**Do not open a public issue for a security vulnerability.**

Use GitHub's **private vulnerability reporting** on this repository ("Security" tab → "Report a vulnerability"), or see [SECURITY.md](./SECURITY.md) for the disclosure policy and contact details. We take security reports seriously and will coordinate a fix and disclosure with you.

## Reporting bugs

Use the bug report issue template and include:

- **Environment**: self-hosted (versions, deployment method) or hosted (app.bike4mind.com)
- **Steps to reproduce**: numbered, minimal, deterministic
- **Expected vs. actual behavior**
- **Logs/screenshots** with any secrets redacted

Precise reproductions get fixed dramatically faster than "it doesn't work" reports.

## Questions and community

- **Bug?** → GitHub issue (template).
- **Feature idea or design question?** → GitHub issue, before writing code.
- **Usage/self-hosting question?** → GitHub Discussions.
- **Security issue?** → Private vulnerability reporting (never a public issue).
- **Licensing question?** → licensing@bike4mind.com.

Thanks for contributing — we're glad you're here. 🚴‍♂️🧠
