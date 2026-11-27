import { registerContributedViews } from '@bike4mind/common';
import { premiumNavigableViews } from '../premium-generated/premiumNavigableViews.generated';
import { Logger } from '@bike4mind/observability';

// Imported for its side effect by each entrypoint that constructs ChatCompletionProcess (pinned by
// navigationViewsWiring.repo.test.ts). A process entered anywhere else sees only the static views.
const { duplicates, rejected } = registerContributedViews(premiumNavigableViews);
if (duplicates.length > 0) {
  Logger.warn('Dropped contributed navigation views whose id was already contributed', { ids: duplicates });
}
if (rejected.length > 0) {
  Logger.warn(
    'Dropped contributed navigation views that failed validation (id, admin-only route fields, target, text limits or the view cap)',
    { ids: rejected }
  );
}
