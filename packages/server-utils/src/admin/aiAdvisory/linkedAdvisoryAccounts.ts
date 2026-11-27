import { isIP } from 'node:net';
import { AuthEventModel, User } from '@bike4mind/database';
import { LINKED_ADVISORY_MAX_LINKS, type LinkedAdvisoryAccount } from '../../app/utils/aiAdvisory';

const DAY_MS = 24 * 60 * 60_000;
const MAX_SEEDS = 100;
const MAX_IPS = 100;
const MAX_ROWS = 2_000;
const MAX_SHARED_ACCOUNTS = 25;
const MAX_CANDIDATES = 100;
const QUERY_MS = 5_000;
type Observation = { userId: string; ip: string; kind: 'signup' | 'login' };
type ScanResult = { accounts: LinkedAdvisoryAccount[]; truncated: boolean };

function correlateObservations(
  seedObservations: Observation[],
  observations: Observation[],
  seedIds: readonly string[]
): Map<string, LinkedAdvisoryAccount['links']> {
  const population = new Map<string, Set<string>>();
  for (const observation of [...seedObservations, ...observations]) {
    const users = population.get(observation.ip) ?? new Set<string>();
    users.add(observation.userId);
    population.set(observation.ip, users);
  }
  const byCandidate = new Map<string, LinkedAdvisoryAccount['links']>();
  const seeds = new Set(seedIds);
  for (const observation of observations) {
    if (seeds.has(observation.userId) || (population.get(observation.ip)?.size ?? 0) > MAX_SHARED_ACCOUNTS) continue;
    const links = byCandidate.get(observation.userId) ?? [];
    for (const source of seedObservations) {
      if (source.ip !== observation.ip) continue;
      const link = {
        sourceUserId: source.userId,
        ip: source.ip,
        sourceKind: source.kind,
        candidateKind: observation.kind,
      };
      if (
        !links.some(
          existing =>
            existing.sourceUserId === link.sourceUserId &&
            existing.ip === link.ip &&
            existing.sourceKind === link.sourceKind &&
            existing.candidateKind === link.candidateKind
        )
      )
        links.push(link);
    }
    if (links.length > 0) byCandidate.set(observation.userId, links);
  }
  return byCandidate;
}

function signupObservation(user: { _id: unknown; signupMeta?: { ip?: string | null } | null }): Observation[] {
  const ip = user.signupMeta?.ip;
  return ip && isIP(ip) ? [{ userId: String(user._id), ip, kind: 'signup' }] : [];
}

/** One hop from AI-flagged accounts, using exact recent signup/login IP observations only. */
export async function findLinkedAdvisoryAccounts(seedUserIds: readonly string[], now: Date): Promise<ScanResult> {
  const uniqueSeeds = [...new Set(seedUserIds)];
  const seedIds = uniqueSeeds.slice(0, MAX_SEEDS);
  if (seedIds.length === 0) return { accounts: [], truncated: false };
  const window = { $gte: new Date(now.getTime() - 7 * DAY_MS), $lt: now };
  const seedUsers = await User.find({ _id: { $in: seedIds }, deletedAt: null, isBanned: { $ne: true } })
    .select('_id signupMeta.ip createdAt')
    .limit(MAX_SEEDS)
    .maxTimeMS(QUERY_MS)
    .lean();
  const liveSeedIds = seedUsers.map(user => String(user._id));
  const seedEvents = await AuthEventModel.find({ userId: { $in: liveSeedIds }, createdAt: window })
    .select('userId ip type')
    .sort({ createdAt: -1, _id: -1 })
    .limit(MAX_ROWS + 1)
    .maxTimeMS(QUERY_MS)
    .lean();
  let seedObservations: Observation[] = seedUsers
    .filter(user => user.createdAt >= window.$gte && user.createdAt < now)
    .flatMap(signupObservation);
  for (const event of seedEvents.slice(0, MAX_ROWS)) {
    if (event.ip && isIP(event.ip)) seedObservations.push({ userId: event.userId, ip: event.ip, kind: event.type });
  }
  const allIps = [...new Set(seedObservations.map(observation => observation.ip))].sort();
  let ips = allIps.slice(0, MAX_IPS);
  let truncated = uniqueSeeds.length > MAX_SEEDS || seedEvents.length > MAX_ROWS || allIps.length > MAX_IPS;
  if (ips.length === 0) return { accounts: [], truncated };

  const loadPopulation = (addresses: string[]) =>
    Promise.all([
      User.find({ 'signupMeta.ip': { $in: addresses }, createdAt: window, deletedAt: null })
        .select('_id name signupMeta.ip')
        .sort({ createdAt: -1, _id: -1 })
        .limit(MAX_ROWS + 1)
        .maxTimeMS(QUERY_MS)
        .lean(),
      AuthEventModel.find({ type: { $in: ['signup', 'login'] }, ip: { $in: addresses }, createdAt: window })
        .select('userId ip type')
        .sort({ createdAt: -1, _id: -1 })
        .limit(MAX_ROWS + 1)
        .maxTimeMS(QUERY_MS)
        .lean(),
    ]);
  let [signupUsers, events] = await loadPopulation(ips);
  // An incomplete population cannot establish that an address is uncommon; retry without addresses proven shared.
  if (signupUsers.length > MAX_ROWS || events.length > MAX_ROWS) {
    const population = new Map<string, Set<string>>();
    const partialObservations = [...seedObservations, ...signupUsers.flatMap(signupObservation)];
    for (const event of events) {
      if (event.ip && isIP(event.ip))
        partialObservations.push({ userId: event.userId, ip: event.ip, kind: event.type });
    }
    for (const observation of partialObservations) {
      const users = population.get(observation.ip) ?? new Set<string>();
      users.add(observation.userId);
      population.set(observation.ip, users);
    }
    const sharedIps = new Set(
      [...population].filter(([, users]) => users.size > MAX_SHARED_ACCOUNTS).map(([ip]) => ip)
    );
    const rowCounts = new Map<string, number>();
    for (const row of [...signupUsers.flatMap(signupObservation), ...events]) {
      if (row.ip) rowCounts.set(row.ip, (rowCounts.get(row.ip) ?? 0) + 1);
    }
    const saturatedIps = [...rowCounts].filter(([ip, rows]) => rows >= MAX_ROWS && !sharedIps.has(ip));
    const droppedIps = new Set([...sharedIps, ...saturatedIps.map(([ip]) => ip)]);
    if (droppedIps.size === 0) return { accounts: [], truncated: true };
    truncated ||= saturatedIps.length > 0;
    ips = ips.filter(ip => !droppedIps.has(ip));
    if (ips.length === 0) return { accounts: [], truncated: true };
    seedObservations = seedObservations.filter(observation => !droppedIps.has(observation.ip));
    [signupUsers, events] = await loadPopulation(ips);
    if (signupUsers.length > MAX_ROWS || events.length > MAX_ROWS) return { accounts: [], truncated: true };
  }
  const observations = signupUsers.flatMap(signupObservation);
  for (const event of events) {
    if (event.ip && isIP(event.ip)) observations.push({ userId: event.userId, ip: event.ip, kind: event.type });
  }
  const byCandidate = correlateObservations(seedObservations, observations, uniqueSeeds);
  const candidateIds = [...byCandidate.keys()].filter(id => /^[a-f0-9]{24}$/i.test(id));
  const candidates = await User.find({ _id: { $in: candidateIds }, deletedAt: null, isBanned: { $ne: true } })
    .select('_id name')
    .sort({ _id: 1 })
    .limit(MAX_CANDIDATES + 1)
    .maxTimeMS(QUERY_MS)
    .lean();
  truncated ||= candidates.length > MAX_CANDIDATES;
  truncated ||= candidates.some(user => (byCandidate.get(String(user._id))?.length ?? 0) > LINKED_ADVISORY_MAX_LINKS);
  return {
    accounts: candidates.slice(0, MAX_CANDIDATES).map(user => ({
      userId: String(user._id),
      name: user.name || null,
      links: (byCandidate.get(String(user._id)) ?? []).slice(0, LINKED_ADVISORY_MAX_LINKS),
    })),
    truncated,
  };
}
