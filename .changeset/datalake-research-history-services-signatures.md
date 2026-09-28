---
"@bike4mind/services": major
---

Several exported `dataLakeResearchService`/`dataLakeService` functions gained required parameters so their History-audit writes can name the real actor and grant set instead of silently falling back to `system`: `createResearchConfig`/`updateResearchConfig`/`deleteResearchConfig` and `startResearchRun` now take the caller's already-loaded `lake`/`actor`/`grants` rather than re-deriving them; `deleteResearchConfig` gained an `actor` param it previously had none of; `recordResearchRunOutcome` gained a required `runId` param so its History row can be paired with the matching `start-research-run` row for the same run. An out-of-repo caller of any of these must update its call sites accordingly.
