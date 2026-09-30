import { DATA_LAKES } from '@bike4mind/common';
import type { MembershipLake } from './lakeMembership';

/**
 * The static registry lakes (`DATA_LAKES`) shaped as membership candidates, so a caller enumerating
 * `(lake, file)` transitions covers them alongside the DB-backed ones.
 *
 * `loadPrefixArmCandidateLakes` cannot reach these: it queries by `createdByUserId`, and a registry
 * lake has no creator - which is also why its prefix arm carries no ownership conjunct. Membership
 * against one of these must therefore be decided with `resolveLakeMembershipScope` (or
 * `registryMembershipScope`), never `lakeMembershipScope`, which fails closed to the meta-tag arm
 * for a creator-less lake and would drop the prefix arm a registry lake is mostly made of.
 *
 * These are candidates for AUDIT enumeration only. There is no document behind them, so a caller
 * must not hand one to a write or a stats recompute - see `assertLakeWritable`.
 */
export const registryCandidateLakes = (): MembershipLake[] =>
  DATA_LAKES.map(config => ({
    id: config.id,
    name: config.name,
    datalakeTag: config.datalakeTag,
    fileTagPrefix: config.fileTagPrefix,
    // Empty, not a real id: there is no creator, and `resolveLakeMembershipScope` branches on the
    // lake being a registry one rather than on this field.
    createdByUserId: '',
    organizationId: undefined,
    requiredPassageTokenTarget: undefined,
  }));
