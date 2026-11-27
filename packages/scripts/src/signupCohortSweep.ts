import { domainToASCII } from 'node:url';
import { z } from 'zod';
import { registrableDomain } from '@bike4mind/utils/registrableDomain';
import type { User } from '@bike4mind/database';
import type { userService } from '@bike4mind/services';

type DomainFacts = userService.DomainFacts;
type SignupGroupingResult = userService.SignupGroupingResult;
type CohortOptions = userService.CohortOptions;

/**
 * Same normalization the records use, so a facts or mailbox entry such as `mail.example.com.` matches.
 * Must stay in sync with normalizeRegistrableDomain in the services package, which is imported lazily here.
 */
const normalizeDomainEntry = (entry: string): string => {
  const ascii = domainToASCII(entry.trim().toLowerCase().replace(/\.+$/, ''));
  const domain = ascii ? registrableDomain(ascii, { allowPrivateDomains: true }) : null;
  if (!domain) throw new Error(`"${entry}" is not a registrable domain`);
  return domain;
};

const domainFactsFileSchema = z.record(
  z.string(),
  z.object({
    mxHosts: z.array(z.string()).optional(),
    nameservers: z.array(z.string()).optional(),
    registrar: z.string().nullish(),
    registeredAt: z.coerce.date().nullish(),
  })
);

/** Parses a `{ "<registrable domain>": { mxHosts, nameservers, registrar, registeredAt } }` file. */
export function parseDomainFactsFile(json: unknown): Map<string, DomainFacts> {
  const parsed = domainFactsFileSchema.parse(json);
  const byDomain = new Map<string, DomainFacts>();
  for (const [entry, facts] of Object.entries(parsed)) {
    const domain = normalizeDomainEntry(entry);
    if (byDomain.has(domain)) {
      throw new Error(`Facts file has more than one entry for ${domain} (including "${entry}")`);
    }
    byDomain.set(domain, facts);
  }
  return byDomain;
}

export const COHORT_CSV_COLUMNS = [
  'row_type',
  'cohort_id',
  'status',
  'domain_count',
  'user_count',
  'datacenter_signups',
  'cohort_domains',
  'bridge_domains',
  'edges',
  'user_id',
  'user_domain',
  'user_created_at',
  'reasons',
] as const;

// Quotes every cell and defuses spreadsheet formulas.
const csvCell = (value: string | number): string => {
  const text = String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
};

/**
 * One `member` row per cohort user, so a reviewer can filter and sample within a cohort, then one
 * `common_key` row per key that was too widespread to link on.
 */
export function renderCohortCsv({ cohorts, commonKeys }: SignupGroupingResult): string {
  const rows: (string | number)[][] = [];
  cohorts.forEach((cohort, index) => {
    const edges = cohort.edges.map(edge => `${edge.domains.join('|')}:${edge.kinds.join('+')}`).join(' ');
    for (const member of cohort.members) {
      rows.push([
        'member',
        index + 1,
        cohort.tooBroad ? 'too_broad' : 'review',
        cohort.domains.length,
        cohort.members.length,
        cohort.datacenterSignups,
        cohort.domains.join(' '),
        cohort.bridgeDomains.join(' '),
        edges,
        member.userId,
        member.domain,
        member.createdAt?.toISOString() ?? '',
        cohort.reasons.join('; '),
      ]);
    }
  });
  for (const key of commonKeys) {
    rows.push(['common_key', '', '', key.domainCount, '', '', '', '', '', '', '', '', key.label]);
  }
  return [COHORT_CSV_COLUMNS.join(','), ...rows.map(row => row.map(csvCell).join(','))].join('\n') + '\n';
}

const positiveInt = z.coerce.number().int().positive();
const share = z.coerce.number().gt(0).max(1);
const isoDate = z.iso.datetime().transform(value => new Date(value));

export type SweepFlags = Partial<Record<string, string>>;

const list = (raw: string | undefined) =>
  (raw ?? '')
    .split(',')
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean);

const parseShapes = (raw: string | undefined): CohortOptions['localPartShapes'] => {
  const shapes = list(raw);
  if (!shapes.includes('any')) return shapes;
  if (shapes.length > 1) throw new Error('--shapes "any" cannot be combined with other shapes');
  return 'any';
};

/** Validates the tuning flags and fills omitted ones from `defaults`. Throws on an invalid value. */
export function buildSweepOptions(flags: SweepFlags, defaults: CohortOptions): CohortOptions {
  const int = (name: string, fallback: number) =>
    flags[name] === undefined ? fallback : positiveInt.parse(flags[name]);
  const userKeyShare = flags['min-user-key-share'];
  return {
    ...defaults,
    localPartShapes: flags.shapes === undefined ? defaults.localPartShapes : parseShapes(flags.shapes),
    ignoredInfrastructureHosts:
      flags['ignore-hosts'] === undefined ? defaults.ignoredInfrastructureHosts : list(flags['ignore-hosts']),
    sharedMailboxDomains:
      flags['mailbox-domains'] === undefined
        ? defaults.sharedMailboxDomains
        : list(flags['mailbox-domains']).map(normalizeDomainEntry),
    minSharedKeyKinds: int('min-shared-key-kinds', defaults.minSharedKeyKinds),
    minDomains: int('min-domains', defaults.minDomains),
    maxDomainsPerKey: int('max-domains-per-key', defaults.maxDomainsPerKey),
    maxDomainsPerInfraKey: int('max-domains-per-infra-key', defaults.maxDomainsPerInfraKey),
    maxCohortDomains: int('max-cohort-domains', defaults.maxCohortDomains),
    minUserKeyShare: userKeyShare === undefined ? defaults.minUserKeyShare : share.parse(userKeyShare),
    minHexLength: int('min-hex-length', defaults.minHexLength),
    registrationBucketDays: int('registration-bucket-days', defaults.registrationBucketDays),
    signupBucketHours: int('signup-bucket-hours', defaults.signupBucketHours),
  };
}

export type SignupSelection = { since?: Date; until?: Date; maxUsers?: number };

/** Validates `--since`, `--until` and `--max-users`. Throws on an invalid value. */
export function parseSignupSelection(flags: SweepFlags): SignupSelection {
  const since = flags.since === undefined ? undefined : isoDate.parse(flags.since);
  const until = flags.until === undefined ? undefined : isoDate.parse(flags.until);
  if (since && until && since >= until) {
    throw new Error('--since must be before --until');
  }
  return {
    since,
    until,
    maxUsers: flags['max-users'] === undefined ? undefined : positiveInt.parse(flags['max-users']),
  };
}

/**
 * Reads the users in the selection with a secondary-preferred cursor, projecting only the fields the
 * grouping needs. Users without a string email are skipped.
 */
export async function readSignupRecords(
  users: Pick<typeof User, 'find'>,
  { since, until, maxUsers }: SignupSelection,
  options: userService.ClusterKeyOptions
): Promise<userService.SignupRecord[]> {
  const { userService: services } = await import('@bike4mind/services');
  const createdAt: Record<string, Date> = {};
  if (since) createdAt.$gte = since;
  if (until) createdAt.$lt = until;
  const query = users
    .find(Object.keys(createdAt).length ? { createdAt } : {}, {
      email: 1,
      createdAt: 1,
      'signupMeta.asn': 1,
      'signupMeta.isDatacenter': 1,
    })
    .read('secondaryPreferred')
    .lean();
  // A stable order makes the cap take the earliest signups instead of whatever the server returns first.
  if (maxUsers) query.sort({ createdAt: 1, _id: 1 }).limit(maxUsers);

  const records: userService.SignupRecord[] = [];
  for await (const doc of query.cursor()) {
    if (typeof doc.email !== 'string') continue;
    records.push(
      services.toSignupRecord(
        {
          userId: String(doc._id),
          email: doc.email,
          createdAt: doc.createdAt instanceof Date ? doc.createdAt : null,
          asn: doc.signupMeta?.asn ?? null,
          isDatacenter: doc.signupMeta?.isDatacenter ?? null,
        },
        options
      )
    );
  }
  if (maxUsers && records.length >= maxUsers) {
    console.warn(`[signup-cohort-sweep] Read the --max-users cap of ${maxUsers}; later signups were not included`);
  }
  return records;
}
