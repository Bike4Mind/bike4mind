import { FabFile, fabFileRepository, organizationRepository, userRepository } from '@bike4mind/database';
import { organizationService, userService } from '@bike4mind/services';
import { type MigrationFile } from './index';

const LOG = '[reconcile-org-stamped-file-storage-owners]';
export const MAX_ATTEMPTS = 3;

type CounterOutcome = 'unchanged' | 'repaired' | 'conflict' | 'missing';
type Tally = Record<CounterOutcome, number>;

const ORG_STAMPED_FILTER = { organizationId: { $type: 'string', $ne: '' } };

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** Raw collection, so soft-deleted rows count too: their uploader was refunded under the old owner rule. */
async function distinctOrgStamped(field: 'userId' | 'organizationId'): Promise<string[]> {
  const values: unknown[] = await FabFile.collection.distinct(field, ORG_STAMPED_FILTER);
  return values.filter(isNonEmptyString);
}

/**
 * Sets one owner's counter to its truth by compare-and-set, re-reading on a lost race. The repair is
 * unconditional (no stability gate, unlike the cron): this runs once at the cutover, where the drift
 * is known to come from the owner-rule change rather than an in-flight split adjustment.
 */
async function settleCounter(
  reconcile: () => Promise<{ drift: number; repaired: boolean; conflict: boolean } | null>
): Promise<CounterOutcome> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const outcome = await reconcile();
    if (!outcome) return 'missing';
    if (outcome.repaired) return 'repaired';
    if (!outcome.conflict) return 'unchanged';
  }
  return 'conflict';
}

async function settleAll(ids: string[], label: string, reconcile: (id: string) => ReturnType<typeof settleCounter>) {
  const tally: Tally = { unchanged: 0, repaired: 0, conflict: 0, missing: 0 };
  for (const id of ids) {
    const outcome = await reconcile(id);
    tally[outcome]++;
    if (outcome === 'conflict') {
      console.warn(`${LOG} ${label} ${id}: counter kept moving over ${MAX_ATTEMPTS} attempts; left for reconciliation`);
    }
  }
  return tally;
}

/**
 * Cutover for billing a FabFile's storage to its owner (storageOwnerOf in @bike4mind/common): an org-stamped
 * row now charges the org, but rows stamped before that rule were charged to their uploader. Those users'
 * counters hold org bytes their truth no longer counts - phantom usage that refuses personal uploads and that
 * a later refund (now routed to the org) never returns - and the orgs' counters miss the same bytes.
 *
 * Sets the counter of every user who uploaded, and every org that owns, an org-stamped row (soft-deleted
 * included) to its truth, through the same reconcile services the storage reconciliation cron uses. The cron
 * does not cover this: it runs dry and only repairs drift that held still across passes.
 *
 * Idempotent: once each counter equals its truth a re-run writes nothing. The id is backdated below
 * BackfillOAuthClientTokenEndpointAuthMethod's 20260922000001, which must stay the highest on disk.
 */
const migration: MigrationFile = {
  id: 20260921235971,
  name: 'reconcile org stamped file storage owners',

  up: async () => {
    const [userIds, organizationIds] = await Promise.all([
      distinctOrgStamped('userId'),
      distinctOrgStamped('organizationId'),
    ]);
    console.log(`${LOG} ${userIds.length} uploader(s) and ${organizationIds.length} org(s) own org-stamped files`);

    const users = await settleAll(userIds, 'user', userId =>
      settleCounter(() =>
        userService.reconcileUserStorage(
          { userId, repair: true },
          { db: { users: userRepository, fabFiles: fabFileRepository } }
        )
      )
    );
    const organizations = await settleAll(organizationIds, 'org', organizationId =>
      settleCounter(() =>
        organizationService.reconcileOrganizationStorage(
          { organizationId, repair: true },
          { db: { organizations: organizationRepository, fabFiles: fabFileRepository } }
        )
      )
    );
    console.log(`${LOG} users ${JSON.stringify(users)}; orgs ${JSON.stringify(organizations)}`);
  },

  down: async () => {
    // The pre-cutover counters were wrong under the owner rule; restoring them would reintroduce the drift.
  },
};

export default migration;
