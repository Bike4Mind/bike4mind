import dayjs from 'dayjs';
import { ModelMetric } from '../types';

export const exportToCSV = (data: ModelMetric[], filename: string) => {
  const headers = [
    'Timestamp',
    'Model Name',
    'Model Backend',
    'Input Tokens',
    'Output Tokens',
    'Total Tokens',
    'Credits Used',
    'Total Response Time (ms)',
    'Context Retrieval Time (ms)',
    'Model Inference Time (ms)',
    'User ID',
    'Organization ID',
    'Project ID',
    'Status',
  ];

  const csvContent = [
    headers.join(','),
    ...data.map(metric =>
      [
        `"${dayjs(metric.timestamp).format('YYYY-MM-DD HH:mm:ss')}"`,
        `"${metric.model?.name || ''}"`,
        `"${metric.model?.backend || ''}"`,
        metric.tokenUsage?.inputTokens || 0,
        metric.tokenUsage?.outputTokens || 0,
        metric.tokenUsage?.totalTokens || 0,
        metric.tokenUsage?.creditsUsed || 0,
        metric.performance?.totalResponseTime || 0,
        metric.performance?.contextRetrievalTime || 0,
        metric.performance?.modelInferenceTime || 0,
        `"${metric.session?.userId || ''}"`,
        `"${metric.session?.organizationId || ''}"`,
        `"${metric.session?.projectId || ''}"`,
        `"${metric.status}"`,
      ].join(',')
    ),
  ].join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};
