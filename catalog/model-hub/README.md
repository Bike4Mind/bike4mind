# Curated models

`curated-v2.json` is bundled with Desktop as its fallback. Builds with a configured online URL and
trusted production keys can also accept newer signed lists; no production keys ship yet. A registry
tag that changes weights, template, parameters, license, projector or draft stops being offered until
the catalog is reviewed and updated pins arrive in a desktop release or an accepted signed list.
Explore remains available for reviewing the live repo.
Do not refresh digests automatically just to make a check green.

Before a desktop release, and whenever changing this catalog:

1. Build core packages with `pnpm turbo:core:build`.
2. Run `pnpm --filter @bike4mind/desktop check:curated`. This reads the live registries without
   downloading weights; any changed or unavailable pin fails the command.
3. On a dedicated Ollama installation, run
   `CURATED_CHECK=pull pnpm --filter @bike4mind/desktop check:curated`.
   This downloads all nine builds, then runs the same `installedReviewed` predicate as Desktop against
   real `/api/show` output, including weights, projector and draft paths. It never deletes models; allow disk space for all builds. To check models
   already installed without pulling, use `CURATED_CHECK=installed`.
4. Repeat the installed check on the declared minimum Ollama version for each build. Select one build
   with `CURATED_BUILD=gemma-4-e4b/qat-q4-0` when testing different minimum versions. The report logs the
   actual daemon version and declared minimum; a pass on a newer version does not prove the minimum.
5. Review upstream changes, licenses and model behavior before updating pins. Increment `sequence`,
   update `updatedAt` and the changelog, run catalog/unit tests, then ship a desktop release. Signed publishing tools are described in
   [packages/scripts](../../packages/scripts/README.md); the production publishing workflow and
   storage configuration are separate work.

Registry checks do not prove how Ollama renders installed templates or joins license layers. Keep the
real installed checks as release evidence, including daemon version and build IDs. GPU, multi-GPU
and Apple unified-memory fit tiers have unit coverage; the original manual test covered CPU-only Linux.
These commands do not establish live GPU or Apple fit accuracy.

If a download finishes with an integrity warning, it remains in the Models download list across tab
and screen changes until dismissed. An unverified model is still installed: return to Curated and use
Check again, or remove it from Installed unless you trust it. A confirmed mismatch is removed only
when the tag was definitely absent before the pull; existing tags and unknown prior state are preserved.
