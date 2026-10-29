import dayjs from 'dayjs';
import { CSV_BOM, toCsv } from '@client/app/hooks/useExportToCSV';
import { downloadData } from '@client/app/utils/download';
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

  const rows = data.map(metric => ({
    Timestamp: dayjs(metric.timestamp),
    'Model Name': metric.model?.name || '',
    'Model Backend': metric.model?.backend || '',
    'Input Tokens': metric.tokenUsage?.inputTokens || 0,
    'Output Tokens': metric.tokenUsage?.outputTokens || 0,
    'Total Tokens': metric.tokenUsage?.totalTokens || 0,
    'Credits Used': metric.tokenUsage?.creditsUsed || 0,
    'Total Response Time (ms)': metric.performance?.totalResponseTime || 0,
    'Context Retrieval Time (ms)': metric.performance?.contextRetrievalTime || 0,
    'Model Inference Time (ms)': metric.performance?.modelInferenceTime || 0,
    'User ID': metric.session?.userId || '',
    'Organization ID': metric.session?.organizationId || '',
    'Project ID': metric.session?.projectId || '',
    Status: metric.status,
  }));

  const csvContent = toCsv(rows, headers, 'YYYY-MM-DD HH:mm:ss');

  downloadData(CSV_BOM + csvContent, filename, 'text/csv;charset=utf-8;');
};
