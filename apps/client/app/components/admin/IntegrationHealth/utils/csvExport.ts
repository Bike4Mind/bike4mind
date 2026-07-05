import type { IntegrationDashboardResponse } from '../types';

export function exportDashboardCsv(data: IntegrationDashboardResponse): void {
  const rows: string[][] = [];

  rows.push([
    'Integration',
    'Status',
    'Latency (ms)',
    'Success Rate',
    'Consecutive Failures',
    'Circuit Breaker Mode',
    'Circuit Breaker Available',
    'Rate Limit Remaining',
    'Rate Limit Total',
    'Rate Limit Usage %',
    'Last Checked',
    'Error',
  ]);

  for (const entry of data.integrations) {
    rows.push([
      entry.name,
      entry.status === 'unhealthy' ? 'down' : entry.status,
      String(entry.latencyMs),
      `${(entry.successRate * 100).toFixed(1)}%`,
      String(entry.consecutiveFailures),
      entry.circuitBreaker.mode,
      String(entry.circuitBreaker.available),
      entry.rateLimit?.remaining != null ? String(entry.rateLimit.remaining) : '--',
      entry.rateLimit?.limit != null ? String(entry.rateLimit.limit) : '--',
      entry.rateLimit?.usagePercent != null ? `${entry.rateLimit.usagePercent}%` : '--',
      entry.lastCheckedAt,
      entry.error || '',
    ]);
  }

  // Add recent errors section
  rows.push([]);
  rows.push(['Recent Errors']);
  rows.push(['Integration', 'Time', 'Source', 'Message', 'Error Code', 'Action']);

  for (const entry of data.integrations) {
    for (const err of entry.recentErrors) {
      rows.push([entry.name, err.occurredAt, err.source, err.message, err.errorCode || '', err.action || '']);
    }
  }

  const escapeCell = (cell: string) => {
    let escaped = cell.replace(/"/g, '""').replace(/\r?\n/g, ' ');
    if (/^[=+\-@]/.test(escaped)) escaped = "'" + escaped;
    return `"${escaped}"`;
  };
  const csv = rows.map(row => row.map(escapeCell).join(',')).join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `integration-health-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
