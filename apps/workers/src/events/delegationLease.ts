import type { delegatedItemRepository } from '@bike4mind/database';

export class DelegationOwnershipLostError extends Error {
  constructor() {
    super('Delegation processing ownership was lost');
    this.name = 'DelegationOwnershipLostError';
  }
}

export class DelegationLeaseUncertainError extends Error {
  constructor(cause: unknown) {
    super('Delegation lease state could not be confirmed', { cause });
    this.name = 'DelegationLeaseUncertainError';
  }
}

/** One serialized renewal at a time. Provider work is never held inside this renewal chain. */
export function startDelegationLease(options: {
  id: string;
  token: string;
  expiresAt: Date;
  leaseMs: number;
  renewEveryMs: number;
  now: () => Date;
  renew: typeof delegatedItemRepository.renewClaim;
  onLost: (error: unknown) => void;
}) {
  const controller = new AbortController();
  let expiresAt = options.expiresAt;
  let stopped = false;
  type LeaseState =
    { status: 'active' } | { status: 'lost'; error: DelegationOwnershipLostError | DelegationLeaseUncertainError };
  let state: LeaseState = { status: 'active' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let renewal: Promise<void> | undefined;
  const lose = (error: unknown) => {
    if (state.status === 'lost') return;
    const failure =
      error instanceof DelegationOwnershipLostError || error instanceof DelegationLeaseUncertainError
        ? error
        : new DelegationLeaseUncertainError(error);
    state = { status: 'lost', error: failure };
    controller.abort();
    options.onLost(failure);
  };
  const assertActive = () => {
    if (state.status === 'active' && options.now().getTime() >= expiresAt.getTime()) {
      lose(new DelegationLeaseUncertainError(new Error('The acknowledged lease expired')));
    }
    if (state.status === 'lost') throw state.error;
  };
  const schedule = () => {
    if (stopped || state.status === 'lost') return;
    timer = setTimeout(() => {
      renewal = (async () => {
        try {
          assertActive();
          const next = await options.renew(options.id, options.token, expiresAt, options.now(), options.leaseMs);
          if (!next) throw new DelegationOwnershipLostError();
          expiresAt = next;
          assertActive();
        } catch (error) {
          lose(error);
        }
      })().finally(() => {
        renewal = undefined;
        schedule();
      });
    }, options.renewEveryMs);
  };
  schedule();
  return {
    signal: controller.signal,
    assertActive,
    lose,
    get expiresAt() {
      return expiresAt;
    },
    get lost() {
      return state.status === 'lost';
    },
    get uncertain() {
      return state.status === 'lost' && state.error instanceof DelegationLeaseUncertainError;
    },
    get error() {
      return state.status === 'lost' ? state.error : undefined;
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await renewal;
    },
  };
}
