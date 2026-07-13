import { describe, expect, it } from 'vitest';
import type { CitableSource } from '@bike4mind/common';
import { aggregateWebFetchContentTelemetry } from './toolContentTelemetry';

const webFetchCitable = (contentLength: number, truncated: boolean, id: string): CitableSource => ({
  id,
  type: 'web_url',
  title: id,
  url: id,
  status: 'complete',
  metadata: { sourceSystem: 'web_fetch', contentLength, truncated },
});

describe('aggregateWebFetchContentTelemetry', () => {
  it('returns zeros for no citables', () => {
    expect(aggregateWebFetchContentTelemetry(undefined)).toEqual({
      truncatedInvocationCount: 0,
      totalExtractedChars: 0,
      maxExtractedChars: 0,
    });
  });

  it('counts truncated invocations and sums/maxes extracted chars', () => {
    const citables = [
      webFetchCitable(50000, true, 'https://a.com'),
      webFetchCitable(10000, false, 'https://b.com'),
      webFetchCitable(50000, true, 'https://c.com'),
    ];
    expect(aggregateWebFetchContentTelemetry(citables)).toEqual({
      truncatedInvocationCount: 2,
      totalExtractedChars: 110000,
      maxExtractedChars: 50000,
    });
  });

  it('ignores citables from other source systems', () => {
    const citables: CitableSource[] = [
      webFetchCitable(50000, true, 'https://a.com'),
      {
        id: 'kb-1',
        type: 'document',
        title: 'doc',
        status: 'complete',
        metadata: { sourceSystem: 'knowledge_base', contentLength: 999999, truncated: true },
      },
    ];
    const res = aggregateWebFetchContentTelemetry(citables);
    expect(res.truncatedInvocationCount).toBe(1);
    expect(res.totalExtractedChars).toBe(50000);
    expect(res.maxExtractedChars).toBe(50000);
  });

  it('treats a missing contentLength as zero', () => {
    const citables: CitableSource[] = [
      { id: 'x', type: 'web_url', title: 'x', status: 'complete', metadata: { sourceSystem: 'web_fetch' } },
    ];
    expect(aggregateWebFetchContentTelemetry(citables).totalExtractedChars).toBe(0);
  });
});
