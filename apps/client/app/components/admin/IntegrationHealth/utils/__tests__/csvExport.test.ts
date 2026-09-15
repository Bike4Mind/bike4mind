/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { exportDashboardCsv } from '../csvExport';
import type { IntegrationDashboardResponse } from '../../types';

function makeResponse(overrides: Partial<IntegrationDashboardResponse> = {}): IntegrationDashboardResponse {
  return {
    generatedAt: '2024-01-15T12:00:00.000Z',
    timeRangeHours: 24,
    integrations: [],
    inMemoryBreakerStates: {},
    ...overrides,
  };
}

describe('exportDashboardCsv', () => {
  let clickSpy: ReturnType<typeof vi.fn>;
  let capturedCsv = '';

  beforeEach(() => {
    capturedCsv = '';
    clickSpy = vi.fn();

    globalThis.URL.createObjectURL = vi.fn().mockReturnValue('blob:test-url');
    globalThis.URL.revokeObjectURL = vi.fn();

    const OriginalBlob = globalThis.Blob;
    vi.spyOn(globalThis, 'Blob').mockImplementation(function (parts?: BlobPart[], options?: BlobPropertyBag) {
      if (parts && parts.length > 0 && typeof parts[0] === 'string') {
        capturedCsv = parts[0] as string;
      }
      return new OriginalBlob(parts, options);
    });

    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'a') {
        return { href: '', download: '', click: clickSpy } as unknown as HTMLElement;
      }
      return document.createElement(tag);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates and triggers a download', () => {
    exportDashboardCsv(makeResponse());
    expect(clickSpy).toHaveBeenCalledOnce();
    expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it('includes header row in CSV', () => {
    exportDashboardCsv(makeResponse());
    expect(capturedCsv).toContain('Integration');
    expect(capturedCsv).toContain('Status');
    expect(capturedCsv).toContain('Latency (ms)');
  });

  it('includes integration data rows', () => {
    const data = makeResponse({
      integrations: [
        {
          name: 'slack',
          status: 'healthy',
          latencyMs: 150,
          lastCheckedAt: '2024-01-15T12:00:00.000Z',
          successRate: 0.95,
          consecutiveFailures: 0,
          error: null,
          circuitBreaker: { available: true, reason: null, mode: 'auto', autoTripped: false },
          rateLimit: null,
          recentErrors: [],
        },
      ],
    });

    exportDashboardCsv(data);
    expect(capturedCsv).toContain('"slack"');
    expect(capturedCsv).toContain('"healthy"');
    expect(capturedCsv).toContain('"150"');
    expect(capturedCsv).toContain('"95.0%"');
  });

  it('escapes double quotes in cell values', () => {
    const data = makeResponse({
      integrations: [
        {
          name: 'github',
          status: 'unhealthy',
          latencyMs: 0,
          lastCheckedAt: '2024-01-15T12:00:00.000Z',
          successRate: 0,
          consecutiveFailures: 3,
          error: 'Error: "timeout"',
          circuitBreaker: { available: false, reason: null, mode: 'auto', autoTripped: true },
          rateLimit: null,
          recentErrors: [],
        },
      ],
    });

    exportDashboardCsv(data);
    expect(capturedCsv).toContain('"down"');
    expect(capturedCsv).toContain('""timeout""');
  });

  it('prefixes formula-injection characters with a single quote', () => {
    const data = makeResponse({
      integrations: [
        {
          name: 'slack',
          status: 'healthy',
          latencyMs: 100,
          lastCheckedAt: '2024-01-15T12:00:00.000Z',
          successRate: 1,
          consecutiveFailures: 0,
          error: '=SUM(A1)',
          circuitBreaker: { available: true, reason: null, mode: 'auto', autoTripped: false },
          rateLimit: null,
          recentErrors: [],
        },
      ],
    });

    exportDashboardCsv(data);
    expect(capturedCsv).toContain('"\'=SUM(A1)"');
  });

  it('escapes newlines in error messages', () => {
    const data = makeResponse({
      integrations: [
        {
          name: 'jira',
          status: 'unhealthy',
          latencyMs: 0,
          lastCheckedAt: '2024-01-15T12:00:00.000Z',
          successRate: 0,
          consecutiveFailures: 1,
          error: null,
          circuitBreaker: { available: true, reason: null, mode: 'auto', autoTripped: false },
          rateLimit: null,
          recentErrors: [
            {
              source: 'health_check',
              occurredAt: '2024-01-15T11:00:00.000Z',
              message: 'Line1\nLine2',
              errorCode: null,
              entityType: null,
              action: 'health_probe',
            },
          ],
        },
      ],
    });

    exportDashboardCsv(data);
    expect(capturedCsv).toContain('Line1 Line2');
    expect(capturedCsv).not.toContain('Line1\nLine2');
  });
});
