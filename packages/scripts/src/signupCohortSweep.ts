import { z } from 'zod';
import type { userService } from '@bike4mind/services';

type DomainFacts = userService.DomainFacts;
type SignupGroupingResult = userService.SignupGroupingResult;

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
  return new Map(Object.entries(parsed).map(([domain, facts]) => [domain.trim().toLowerCase(), facts]));
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
