import type { AnalyticsOverview, AnalyticsTopAccounts, TopAccountRow } from '@client/app/utils/analyticsOverview';
import { CSV_BOM, toCsvFromRecords } from '@client/app/utils/csv';
import { downloadData } from '@client/app/utils/download';
import { featureLabel } from './analyticsFormat';

export type AnalyticsCsvFile = { name: string; csv: string };

const csvFile = (name: string, columns: string[], rows: Record<string, unknown>[]): AnalyticsCsvFile => ({
  name,
  csv: CSV_BOM + toCsvFromRecords(rows, columns),
});

const PARTIAL = 'Partial day (today)';
const yesNo = (value: boolean) => (value ? 'yes' : 'no');
const share = (value: number) => Number(value.toFixed(2));

function topAccountsFile(name: string, idLabel: string, rows: readonly TopAccountRow[]): AnalyticsCsvFile {
  const columns = [
    'Rank',
    idLabel,
    'Name',
    'Plan',
    'Active days',
    'AI requests',
    'Credits consumed',
    'Share of requests (%)',
  ];
  return csvFile(
    name,
    columns,
    rows.map((row, index) => ({
      Rank: index + 1,
      [idLabel]: row.id,
      Name: row.name,
      Plan: row.plan,
      'Active days': row.activeDays,
      'AI requests': row.requests,
      'Credits consumed': row.credits,
      'Share of requests (%)': share(row.share),
    }))
  );
}

/**
 * One CSV per section on the page, for the range on screen (spec 4.10). Days are UTC `YYYY-MM-DD`, units
 * are in the headers, and a missing rollup day is an empty cell rather than 0. Cells go through
 * toCsvFromRecords, which quotes per RFC 4180 and defuses formula prefixes.
 */
export function buildAnalyticsCsvFiles(
  overview: AnalyticsOverview,
  topAccounts: AnalyticsTopAccounts | undefined
): AnalyticsCsvFile[] {
  const compare = overview.window.previous !== null;
  const { sources } = overview.activeUsers;
  const { features } = overview.usage;
  const sourceColumn = (source: string) => `${source} (AI requests)`;
  const featureColumn = (feature: string) => `${featureLabel(feature)} (AI requests)`;

  const files = [
    csvFile(
      'active-users.csv',
      [
        'Day (UTC)',
        PARTIAL,
        'DAU (users)',
        'WAU (users)',
        'MAU (users)',
        ...(compare ? ['MAU, previous period (users)'] : []),
      ],
      overview.activeUsers.days.map(day => ({
        'Day (UTC)': day.day,
        [PARTIAL]: yesNo(day.partial),
        'DAU (users)': day.dau,
        'WAU (users)': day.wau,
        'MAU (users)': day.mau,
        'MAU, previous period (users)': day.previousMau,
      }))
    ),
    csvFile(
      'requests-by-surface.csv',
      ['Day (UTC)', PARTIAL, ...sources.map(sourceColumn)],
      overview.activeUsers.bySource.map(day => ({
        'Day (UTC)': day.day,
        [PARTIAL]: yesNo(day.partial),
        ...Object.fromEntries(
          sources.map(source => [sourceColumn(source), day.counts ? (day.counts[source] ?? 0) : null])
        ),
      }))
    ),
    csvFile(
      'signups.csv',
      [
        'Bucket start (UTC)',
        'Bucket end, exclusive (UTC)',
        'Partial bucket',
        'Likely legit (signups)',
        'Suspected (signups)',
        'Unclassified (signups)',
      ],
      overview.signups.buckets.map(bucket => ({
        'Bucket start (UTC)': bucket.start,
        'Bucket end, exclusive (UTC)': bucket.end,
        'Partial bucket': yesNo(bucket.partial),
        'Likely legit (signups)': bucket.legit,
        'Suspected (signups)': bucket.suspected,
        'Unclassified (signups)': bucket.unclassified,
      }))
    ),
    csvFile(
      'signup-signals.csv',
      ['Signal', 'Signups flagged'],
      overview.signups.bySignal.map(row => ({ Signal: row.signal, 'Signups flagged': row.count }))
    ),
    csvFile(
      'usage-by-feature.csv',
      ['Day (UTC)', PARTIAL, ...features.map(featureColumn)],
      overview.usage.days.map(day => ({
        'Day (UTC)': day.day,
        [PARTIAL]: yesNo(day.partial),
        ...Object.fromEntries(
          features.map(feature => [featureColumn(feature), day.byFeature ? (day.byFeature[feature] ?? 0) : null])
        ),
      }))
    ),
    csvFile(
      'requests-by-model.csv',
      ['Model', 'AI requests', 'Share of requests (%)'],
      [
        ...overview.usage.models.map(model => ({
          Model: model.model,
          'AI requests': model.requests,
          'Share of requests (%)': share(model.share),
        })),
        ...(overview.usage.otherModelRequests > 0
          ? [
              {
                Model: 'Other models',
                'AI requests': overview.usage.otherModelRequests,
                'Share of requests (%)': share(
                  (overview.usage.otherModelRequests / Math.max(1, overview.usage.totals.requests)) * 100
                ),
              },
            ]
          : []),
      ]
    ),
    csvFile(
      'credits-consumed.csv',
      ['Day (UTC)', PARTIAL, 'Credits consumed (credits)'],
      overview.usage.days.map(day => ({
        'Day (UTC)': day.day,
        [PARTIAL]: yesNo(day.partial),
        'Credits consumed (credits)': day.credits,
      }))
    ),
  ];
  if (topAccounts) {
    files.push(
      topAccountsFile('top-users.csv', 'User ID', topAccounts.users),
      topAccountsFile('top-organizations.csv', 'Organization ID', topAccounts.orgs)
    );
  }
  return files;
}

/** Downloads every section as one zip, named for the UTC range on screen. */
export async function downloadAnalyticsExport(
  overview: AnalyticsOverview,
  topAccounts: AnalyticsTopAccounts | undefined
): Promise<void> {
  // Loaded on click: the zip writer is only needed by this one button.
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  for (const file of buildAnalyticsCsvFiles(overview, topAccounts)) zip.file(file.name, file.csv);
  const blob = await zip.generateAsync({ type: 'blob' });
  downloadData(blob, `analytics_${overview.window.from}_${overview.window.to}_utc.zip`, 'application/zip');
}
