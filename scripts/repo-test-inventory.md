# Repository scan lanes

Repository scans run through package `test:repo` scripts, directly and uncached on
the CI `misc` leg. Each package config includes only `*.repo.test.ts` in that lane
and excludes them from ordinary and integration lanes. Turbo also declares
`test:repo` non-cacheable. The cache guard asks Vitest to discover all three lanes
and compares the repo lane with tracked files, including uniqueness.

## Seven-package inventory snapshot

Names below omit the `.repo.test.ts` suffix. Renames preserve complete test bodies
except the database extraction and a services scanner's self-allowlist path.
This is the rollout snapshot, not a maintained manifest. The discovery guard uses
tracked repo-test files as the live inventory and verifies their lane coverage.

| Package | Uncached files | Coverage |
| --- | --- | --- |
| database | `src/models/ai/LakeAccessEventModel` | Whole-tree git scan; extracted from the Mongo-backed model suite, whose other assertions stay ordinary. |
| infra | `src/__tests__/{fabFileExtractedCountInvalidation,fabFileModerationGate,productGateCoverage,securityGroupRuleDescription}` | Cross-package source walks, route coverage and infra tree checks. |
| resource | `src/manifestCoverage` | Resource consumers across source trees and self-host parity. |
| services-core | `src/dataLakeService/applyCorpusAction.guardrail`, `src/index.closure` | Whole-tree corpus-action references and cross-package core import closure. |
| server-utils | `src/moderation/imageModerationIncidents.wiring`, `src/tutorials/__tests__/registry.clientImports`, `src/utils/settleStrandedQuests.wiring` | Cross-package consumer discovery and caller/import checks. |
| workers | `src/queueHandlers/orgAlertObserverEntries` | Entry-point discovery across worker sources. Package-local but uncached to keep scan coverage independent of ordinary selection. |
| scripts | `migrate/reencrypt-stored-secrets-coverage`; `src/{checkChangesFilterEvents,checkComposeFoldedComments,checkE2ePreviewSecretGuard,checkEmbeddingModelComparisonSites,checkLakeReachabilitySites,checkMailSendSites,checkNoProvisionedConcurrency,checkNoRawS3Client,checkNpmPublishSources,checkReplSetSuitesSettleIndexBuilds,checkSanitizeHtmlTranspile,checkSelfhostPaths,checkStorageLimitConversion,checkViMockSpecifierDrift,checkWorkersMovedDirs,repositoryWholeDocUpdate,selfhostParityInventory}` | Source, workflow, compose, packaging, migration and self-host scans, including scanners invoked through shell helpers. |

Package-local walks remain ordinary: database barrel completeness and update-path
fixtures; services tool usage and evaluation corpus checks; workers/server-utils
Mongo timeout audits; scripts migration-directory checks and temporary fixture
walks. Their package files are default inputs. Cross-package Mongo audit helpers
come through the declared database build dependency.

## Remaining cached inputs

Six packages leave the always-on list. Their bounded reads remain covered by
package-specific `test` inputs (mirrored for `test:integration` where present):

- database: the shared HTTP ability source.
- infra: buckets, client router, Changesets wrapper/config and root dependency
  manifests, plus the pre-existing cross-package source inputs.
- resource: ElasticMQ config, env template and public-exposure additions.
- services-core: catalog seed, alarms, web and queues; dashboard remains a global
  dependency.
- server-utils: curated catalog plus the existing app, worker, infra and self-host
  inputs, including generated inputs and the codegen dependency.
- workers: existing client/server-utils/help inputs plus bounded infra files,
  ElasticMQ config, directly imported notebook curation sources, source-only
  scripts entries and their migration, seeder and config trees, help docs and curated catalog.

`@bike4mind/scripts` deliberately remains always-on and whole-tree keyed. Its
remaining suites still calculate external paths dynamically, including the AI
latency factory/spec checks, workflow guards, client packaging checks and export
schema fixtures. The existing escaped-path guard, when run without that exception,
reports uncovered client app/e2e, workflow, blueprint, export-schema, root script
and infra paths. Removing the exception is not justified by these renames.

## Verification

The focused cache and affected-selection guards cover every workspace's escaped
literals, git scans, source-only entries, mirrored inputs, missing repo scripts,
CI lane wiring, and discovery exclusivity. Root-based literal checks additionally
inspect concrete repo-relative paths for these seven packages. This is a static
guard, not a complete runtime filesystem dependency tracer; computed reads still
require review and uncertain packages must retain the whole-tree exception.

Representative plans: a README-only diff omits ordinary suites of the six removed
packages while `misc` still sets up and invokes every repo script. An ElasticMQ
edit selects resource/workers; alarms selects services-core; buckets selects infra;
the curated catalog selects server-utils; the shared HTTP ability selects database.
Changes to selection/configuration files still use the full-run backstop. No
client-related selection logic or E2E workflows are changed.
