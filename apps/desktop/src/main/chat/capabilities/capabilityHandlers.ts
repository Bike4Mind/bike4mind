import type { CapabilityLedger } from './CapabilityLedger';
import { enforceRevocation, type RevocationTargets } from './approvalCapabilities';

type Ledger = Pick<CapabilityLedger, 'state' | 'migrate' | 'revoke' | 'revokeMatching'>;
type Logger = { warn(message: string): void };

/** Audit synchronization must never reject an already successful permission mutation. */
export async function syncCapabilityChange(sync: () => Promise<unknown>, logger: Logger): Promise<void> {
  try {
    await sync();
  } catch (error) {
    logger.warn(`CAPABILITIES: could not synchronize grants: ${String(error)}`);
  }
}

/** Return the committed result and settle approvals even if audit storage is unavailable. */
export async function completeCapabilityMutation<Result>(
  result: Result,
  sync: () => Promise<unknown>,
  logger: Logger,
  afterSync?: () => void
): Promise<Result> {
  await syncCapabilityChange(sync, logger);
  afterSync?.();
  return result;
}

/** Standing approvals live in memory and do not survive an app restart. */
export async function retireSessionApprovals(ledger: Ledger): Promise<void> {
  await ledger.revokeMatching(grant => grant.subject.kind === 'session' && grant.scope.kind !== 'path');
}

export function capabilityHandlers(options: {
  ledger: Ledger;
  ready: Promise<unknown>;
  scopeKey(): string | null;
  sessions(): Promise<Parameters<CapabilityLedger['migrate']>[0]['sessions']>;
  targets: RevocationTargets;
}) {
  const { ledger } = options;
  return {
    getState: async () => {
      await options.ready;
      const scopeKey = options.scopeKey();
      const sessions = await options.sessions();
      if (scopeKey !== options.scopeKey()) throw new Error('Account changed while loading capability grants.');
      if (scopeKey !== null) {
        await ledger.migrate({
          roots: [],
          trustedProjects: [],
          permissions: { user: { allow: [], ask: [], deny: [] }, projects: {} },
          sessions,
          scopeKey,
        });
      }
      if (scopeKey !== options.scopeKey()) throw new Error('Account changed while loading capability grants.');
      const state = await ledger.state(scopeKey);
      if (scopeKey !== options.scopeKey()) throw new Error('Account changed while loading capability grants.');
      return state;
    },
    revoke: async (grantId: unknown) => {
      await options.ready;
      if (typeof grantId !== 'string') throw new Error('Invalid capability grant.');
      const scopeKey = options.scopeKey();
      const revoked = await ledger.revoke(
        grantId,
        async grant => {
          if (scopeKey !== options.scopeKey()) throw new Error('Account changed while revoking capability grant.');
          return enforceRevocation(grant, options.targets);
        },
        scopeKey
      );
      if (!revoked) throw new Error('Capability grant is no longer active.');
      if (scopeKey !== options.scopeKey()) throw new Error('Account changed while revoking capability grant.');
      const state = await ledger.state(scopeKey);
      if (scopeKey !== options.scopeKey()) throw new Error('Account changed while loading capability grants.');
      return state;
    },
  };
}
