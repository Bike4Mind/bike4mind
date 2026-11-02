import type { CapabilityScope } from '@shared/capabilities';
import type { ModelPull, ModelStoreLocation } from '@shared/models';
import type { CapabilityLedger } from '../chat/capabilities/CapabilityLedger';
import type { StartedPull } from './ModelHubService';

type Ledger = Pick<CapabilityLedger, 'grant' | 'use' | 'revokeMatching'>;

const isPullGrant = (grant: { capability: string; scope: CapabilityScope }) =>
  grant.capability === 'model-download' && grant.scope.kind === 'model-pull';

/** A failed download stays listed until dismissed, but it is over. */
const running = (pulls: readonly ModelPull[]) =>
  new Set(pulls.filter(pull => pull.phase !== 'failed').map(pull => pull.key));

/**
 * Records each approved model download in the capability ledger: a grant and its use when the download starts,
 * revoked once it ends. A ledger that cannot be written never stops a download the user already approved.
 */
export class PullLedger {
  #runningKeys = '';
  #settling: Promise<void> = Promise.resolve();

  constructor(
    private readonly ledger: Ledger,
    private readonly pulls: () => readonly ModelPull[],
    private readonly warn: (message: string) => void
  ) {}

  async started(pull: StartedPull, location: ModelStoreLocation | null): Promise<void> {
    const scope: CapabilityScope = {
      kind: 'model-pull',
      value: pull.key,
      model: pull.label && !pull.ref.endsWith(`:${pull.label}`) ? `${pull.ref} (${pull.label})` : pull.ref,
      server: pull.serverName,
      bytes: pull.sizeBytes,
      ...(location?.path && location.source ? { path: location.path, pathSource: location.source } : {}),
    };
    try {
      const grant = await this.ledger.grant({
        subject: { kind: 'desktop-user' },
        capability: 'model-download',
        scope,
        source: 'approval',
      });
      await this.ledger.use('model-download', grant.scope, grant.id);
      // The download can end before its grant is written; settled() has then already looked.
      if (!running(this.pulls()).has(pull.key)) await this.ledger.revokeMatching(entry => entry.id === grant.id);
    } catch (error) {
      this.warn(`MODELS: could not record a download in the capability ledger: ${String(error)}`);
    }
  }

  /** Revokes the grant of every download that is no longer running. */
  settled(pulls: readonly ModelPull[]): Promise<void> {
    // One at a time: a call overlapping an unfinished one would compare against keys that write had not stored yet.
    this.#settling = this.#settling.then(() => this.#settle(pulls));
    return this.#settling;
  }

  async #settle(pulls: readonly ModelPull[]): Promise<void> {
    const live = running(pulls);
    const keys = [...live].sort().join('\n');
    if (keys === this.#runningKeys) return;
    try {
      await this.ledger.revokeMatching(grant => isPullGrant(grant) && !live.has(grant.scope.value));
      // Only after the write, so the next change retries a revoke that failed.
      this.#runningKeys = keys;
    } catch (error) {
      this.warn(`MODELS: could not close a download's capability grant: ${String(error)}`);
    }
  }

  /** Downloads do not survive a restart, so no grant for one stays open across it. */
  async retireAll(): Promise<void> {
    try {
      await this.ledger.revokeMatching(isPullGrant);
    } catch (error) {
      this.warn(`MODELS: could not close earlier download grants: ${String(error)}`);
    }
  }
}
