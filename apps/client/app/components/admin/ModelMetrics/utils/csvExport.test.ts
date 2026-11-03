import { describe, expect, it, vi } from 'vitest';
import { CSV_BOM } from '@client/app/utils/csv';
import type { ModelMetric } from '../types';

const downloadData = vi.hoisted(() => vi.fn());
vi.mock('@client/app/utils/download', () => ({ downloadData }));

import { exportToCSV } from './csvExport';

const metric: ModelMetric = {
  id: 'm1',
  timestamp: '2026-03-04T10:05:06',
  model: { name: 'model-a', backend: 'backend-a' },
  tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, creditsUsed: 2 },
  performance: { totalResponseTime: 900, contextRetrievalTime: 100, modelInferenceTime: 800 },
  session: { userId: 'u1', organizationId: '=org', projectId: 'p1' },
  status: 'completed',
};

describe('model metrics exportToCSV', () => {
  it('maps each metric to its column and downloads through the shared helper', () => {
    exportToCSV([metric], 'metrics.csv');

    expect(downloadData).toHaveBeenCalledTimes(1);
    const [content, filename, type] = downloadData.mock.calls[0];
    expect(filename).toBe('metrics.csv');
    expect(type).toBe('text/csv;charset=utf-8;');

    const [header, row] = String(content).slice(CSV_BOM.length).split('\r\n');
    expect(String(content).startsWith(CSV_BOM)).toBe(true);
    expect(header.split(',')).toEqual([
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
    ]);
    expect(row.split(',')).toEqual([
      '2026-03-04 10:05:06',
      'model-a',
      'backend-a',
      '10',
      '5',
      '15',
      '2',
      '900',
      '100',
      '800',
      'u1',
      "'=org",
      'p1',
      'completed',
    ]);
  });
});
