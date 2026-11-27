import type { DataHolderRegistry } from '../types';

export const hearthHolders = {
  HearthActor: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
    // The spawning actor (an agent or device of the same account), not a user.
    unrelatedPaths: ['parentActorId'],
  },
  HearthChannel: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
    // The gateway actor mirroring an external network, not a user.
    unrelatedPaths: ['gatewayActorId'],
  },
  HearthCursor: { kind: 'viaParent', parent: 'HearthActor', foreignKey: 'actorId' },
  HearthEvent: { kind: 'viaParent', parent: 'HearthActor', foreignKey: 'actorId' },
  HearthPresence: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
    // The actor row belongs to the same user and is erased through HearthActor.
    unrelatedPaths: ['actorId'],
  },
} satisfies DataHolderRegistry;
