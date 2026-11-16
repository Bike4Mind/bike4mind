import type { IUsageDashboardResponse, IUsageSpendBucket } from '@bike4mind/common';

const cell = (value: string | number): string => {
  const text = String(value);
  const safe = /^[\s]*[=+\-@]/.test(text) && typeof value === 'string' ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
};

export const usageCsv = (data: IUsageDashboardResponse): string => {
  const rows: (string | number)[][] = [
    [
      'Owner ID',
      'Window days',
      'Breakdown',
      'ID',
      'Label',
      'Requests',
      'Credits',
      'COGS USD',
      'Input tokens',
      'Output tokens',
    ],
  ];
  const add = (kind: string, id: string, label: string, bucket: IUsageSpendBucket) =>
    rows.push([
      data.ownerId,
      data.days,
      kind,
      id,
      label,
      bucket.requests,
      bucket.creditsCharged,
      bucket.cogsUsd,
      '',
      '',
    ]);
  add('total', '', 'Total usage events', data.totals);
  data.overTime.forEach(row => add('day', row.day, row.day, row));
  data.byMember.forEach(row => add('member', row.userId, row.userName ?? 'Unknown user', row));
  data.byModel.forEach(row => add('model', `${row.provider}/${row.model}`, `${row.provider} / ${row.model}`, row));
  data.byProject.forEach(row => add('project', row.projectId ?? '', row.projectId ?? 'Unassigned', row));
  data.byFeature.forEach(row => add('feature', row.feature, row.feature, row));
  data.byApiKey.forEach(row =>
    rows.push([
      data.ownerId,
      data.days,
      'api_key_ledger',
      row.apiKeyId,
      row.keyName ?? 'Unknown key',
      row.requests,
      row.creditsSpent,
      '',
      row.inputTokens,
      row.outputTokens,
    ])
  );
  data.bySource.forEach(row =>
    rows.push([
      data.ownerId,
      data.days,
      'source_ledger',
      row.source,
      row.source === 'unclassified' ? 'Unclassified' : row.source,
      row.requests,
      row.creditsSpent,
      '',
      '',
      '',
    ])
  );
  return rows.map(row => row.map(cell).join(',')).join('\r\n');
};

export const downloadUsageCsv = (data: IUsageDashboardResponse): void => {
  const url = URL.createObjectURL(new Blob([usageCsv(data)], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `usage-${data.ownerId}-${data.days}d.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};
