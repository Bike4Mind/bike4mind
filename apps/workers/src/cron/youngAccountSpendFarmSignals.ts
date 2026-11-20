import type { Logger } from '@bike4mind/observability';
import { mailboxAliasesOf } from '@bike4mind/common';
import {
  authEventRepository,
  counterLogRepository,
  shadowDetectionRepository,
  userApiKeyRepository,
  userRepository,
} from '@bike4mind/database';
import type { SpendChannels, UserAccountRiskProfile, UserLinkState, YoungAccountSpender } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { accountLinkKeys } from '@bike4mind/server-utils/security/accountLinkSignals';

/**
 * Farm-pattern signals for the young-account spend detector (youngAccountSpendShadowDetections.ts).
 * High spend from a young account alone also describes a keen new user, so policy v3 records a
 * detection only when the spend coincides with at least one of these. Each signal is read on its own:
 * a failed read leaves that signal unknown (null) and never fires it.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** An API key or authenticator 2FA this soon after signup reads as a scripted setup. */
export const FARM_SETUP_MINUTES = 10;
/** Other signups this close to the account's own count as a sibling on its network. */
export const NETWORK_PEER_WINDOW_HOURS = 24;
/** How far either side of signup a linked account may have been created. */
export const FLAGGED_LINK_WINDOW_HOURS = 72;
const NETWORK_PEER_MAX_ROWS = 500;
const LINK_CANDIDATE_LIMIT = 50;
/** AuthEvent rows expire after 90 days; a window older than that is rejected by the repository. */
const AUTH_EVENT_RETENTION_MS = 90 * 24 * HOUR_MS;

export const FARM_SIGNAL_KEYS = [
  'apiOnlySpend',
  'apiKeySoonAfterSignup',
  'authenticatorSoonAfterSignup',
  'youngNetworkPeer',
  'linkedToFlaggedAccount',
] as const;
export type FarmSignalKey = (typeof FARM_SIGNAL_KEYS)[number];

/** Distinct other accounts that signed up within NETWORK_PEER_WINDOW_HOURS; null when unknown. */
export type NetworkPeers = {
  sameIp: number | null;
  /** IPv4 /24. */
  samePrefix: number | null;
  sameAsn: number | null;
  /** The signup network was a datacenter or an anonymizing service, so an ASN peer counts. */
  anonymizingNetwork: boolean;
};

/** Null on any field means the fact could not be read. */
export type FarmSignals = {
  spendChannels: SpendChannels | null;
  /** Minutes from signup to the first API key; null when there is no key or it is unknown. */
  minutesToApiKey: number | null;
  /** Minutes from signup to authenticator (TOTP) setup; null when not enrolled or unknown. */
  minutesToAuthenticator: number | null;
  networkPeers: NetworkPeers | null;
  /** Linked accounts (signup IP, JA4, mailbox or company mail domain) that are blocked or confirmed abuse. */
  flaggedLinkedAccounts: number | null;
};

export const UNKNOWN_FARM_SIGNALS: FarmSignals = {
  spendChannels: null,
  minutesToApiKey: null,
  minutesToAuthenticator: null,
  networkPeers: null,
  flaggedLinkedAccounts: null,
};

/** Every web, CLI or desktop credit counts against it, so one chat turn in the window clears it. */
export const isApiOnlySpend = (channels: SpendChannels | null): boolean | null =>
  channels === null ? null : channels.apiCredits > 0 && channels.chatCredits === 0;

/** An exact IP or /24 peer always counts; an ASN peer only on a datacenter or anonymizing network. */
export function networkPeerCount(peers: NetworkPeers | null): number | null {
  if (peers === null) return null;
  const counts = [peers.sameIp, peers.samePrefix, ...(peers.anonymizingNetwork ? [peers.sameAsn] : [])];
  const known = counts.filter((count): count is number => count !== null);
  return known.length === 0 ? null : Math.max(...known);
}

const withinSetupWindow = (minutes: number | null): boolean => minutes !== null && minutes <= FARM_SETUP_MINUTES;

/** The farm signals that fired, in FARM_SIGNAL_KEYS order. */
export function firedFarmSignals(signals: FarmSignals): FarmSignalKey[] {
  const fired: Record<FarmSignalKey, boolean> = {
    apiOnlySpend: isApiOnlySpend(signals.spendChannels) === true,
    apiKeySoonAfterSignup: withinSetupWindow(signals.minutesToApiKey),
    authenticatorSoonAfterSignup: withinSetupWindow(signals.minutesToAuthenticator),
    youngNetworkPeer: (networkPeerCount(signals.networkPeers) ?? 0) > 0,
    linkedToFlaggedAccount: (signals.flaggedLinkedAccounts ?? 0) > 0,
  };
  return FARM_SIGNAL_KEYS.filter(key => fired[key]);
}

export type FarmSignalDeps = {
  findAccountRiskProfiles: (ids: string[]) => Promise<UserAccountRiskProfile[]>;
  findSpendChannelsByUsers: (ids: string[], start: Date, end: Date) => Promise<Record<string, SpendChannels>>;
  findFirstApiKeyCreatedAt: (ids: string[]) => Promise<Record<string, Date>>;
  recentDistinctSignups: typeof authEventRepository.recentDistinctSignups;
  findSignupLinkCandidates: typeof userRepository.findSignupLinkCandidates;
  findConfirmedAbuseUserIds: (ids: string[]) => Promise<string[]>;
  isBlocked: (account: UserLinkState) => boolean;
  now: () => Date;
};

export const liveFarmSignalDeps: FarmSignalDeps = {
  findAccountRiskProfiles: ids => userRepository.findAccountRiskProfiles(ids),
  findSpendChannelsByUsers: (ids, start, end) => counterLogRepository.findSpendChannelsByUsers(ids, start, end),
  findFirstApiKeyCreatedAt: ids => userApiKeyRepository.findFirstCreatedAtByUserIds(ids),
  recentDistinctSignups: input => authEventRepository.recentDistinctSignups(input),
  findSignupLinkCandidates: input => userRepository.findSignupLinkCandidates(input),
  findConfirmedAbuseUserIds: ids => shadowDetectionRepository.findConfirmedAbuseUserIds(ids),
  isBlocked: account => userService.accountBlockReasons(account).length > 0,
  now: () => new Date(),
};

const minutesBetween = (from: Date, to: Date): number =>
  Math.max(0, Math.round((to.getTime() - from.getTime()) / MINUTE_MS));

async function readNetworkPeers(
  profile: UserAccountRiskProfile,
  createdAt: Date,
  deps: FarmSignalDeps
): Promise<NetworkPeers> {
  const now = deps.now().getTime();
  const windowMs = NETWORK_PEER_WINDOW_HOURS * HOUR_MS;
  // A minute inside retention, so the repository's own bound never rejects a window at the edge.
  const since = new Date(Math.max(createdAt.getTime() - windowMs, now - AUTH_EVENT_RETENTION_MS + MINUTE_MS));
  const until = new Date(Math.min(createdAt.getTime() + windowMs, now));
  const anonymizingNetwork = profile.signupDatacenter === true || profile.signupWafAnonIp === true;
  if (since >= until) return { sameIp: null, samePrefix: null, sameAsn: null, anonymizingNetwork };
  const counts = await deps.recentDistinctSignups({
    userId: profile.id,
    since,
    until,
    ip: profile.signupIp,
    asn: profile.signupAsn,
    maxRows: NETWORK_PEER_MAX_ROWS,
  });
  return {
    sameIp: counts.ipSignups,
    samePrefix: counts.prefixSignups,
    sameAsn: counts.asnSignups,
    anonymizingNetwork,
  };
}

async function readFlaggedLinks(
  profile: UserAccountRiskProfile,
  createdAt: Date,
  deps: FarmSignalDeps
): Promise<number> {
  const keys = accountLinkKeys(profile);
  const windowMs = FLAGGED_LINK_WINDOW_HOURS * HOUR_MS;
  const candidates = await deps.findSignupLinkCandidates({
    excludeIds: [profile.id],
    from: new Date(createdAt.getTime() - windowMs),
    to: new Date(createdAt.getTime() + windowMs),
    ip: keys.signupIp,
    ja4: keys.ja4,
    mailbox: profile.email ? mailboxAliasesOf(profile.email) : null,
    mailDomain: keys.mailDomain,
    limit: LINK_CANDIDATE_LIMIT,
  });
  if (candidates.length === 0) return 0;
  const confirmed = new Set(await deps.findConfirmedAbuseUserIds(candidates.map(candidate => candidate.id)));
  return candidates.filter(candidate => deps.isBlocked(candidate) || confirmed.has(candidate.id)).length;
}

/** Runs one read; a failure is logged and leaves the fact unknown. */
async function settle<T>(read: () => Promise<T>, what: string, logger: Pick<Logger, 'error'>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    logger.error(`young-account spend farm signal read failed: ${what}`, { error });
    return null;
  }
}

/** Farm signals for each listed spender, keyed by user id; never throws. */
export async function loadFarmSignals(input: {
  spenders: readonly YoungAccountSpender[];
  window: { start: Date; end: Date };
  logger: Pick<Logger, 'error'>;
  deps?: FarmSignalDeps;
}): Promise<Map<string, FarmSignals>> {
  const { spenders, window, logger } = input;
  const deps = input.deps ?? liveFarmSignalDeps;
  const ids = spenders.map(spender => spender.userId);
  if (ids.length === 0) return new Map();
  const [profiles, channels, firstKeys] = await Promise.all([
    settle(() => deps.findAccountRiskProfiles(ids), 'account profiles', logger),
    settle(() => deps.findSpendChannelsByUsers(ids, window.start, window.end), 'spend channels', logger),
    settle(() => deps.findFirstApiKeyCreatedAt(ids), 'API keys', logger),
  ]);
  const profileById = new Map((profiles ?? []).map(profile => [profile.id, profile]));

  const entries = await Promise.all(
    spenders.map(async (spender): Promise<[string, FarmSignals]> => {
      const createdAt = new Date(spender.accountCreatedAt);
      const firstKey = firstKeys?.[spender.userId] ?? null;
      const profile = profileById.get(spender.userId) ?? null;
      const [networkPeers, flaggedLinkedAccounts] = profile
        ? await Promise.all([
            settle(() => readNetworkPeers(profile, createdAt, deps), 'network peers', logger),
            settle(() => readFlaggedLinks(profile, createdAt, deps), 'flagged links', logger),
          ])
        : [null, null];
      return [
        spender.userId,
        {
          // A spender absent from the channel read had no AI spend there, which is not API-only.
          spendChannels: channels === null ? null : (channels[spender.userId] ?? { apiCredits: 0, chatCredits: 0 }),
          minutesToApiKey: firstKey ? minutesBetween(createdAt, new Date(firstKey)) : null,
          minutesToAuthenticator:
            profile?.mfaEnabled && profile.mfaSetupAt ? minutesBetween(createdAt, new Date(profile.mfaSetupAt)) : null,
          networkPeers,
          flaggedLinkedAccounts,
        },
      ];
    })
  );
  return new Map(entries);
}
