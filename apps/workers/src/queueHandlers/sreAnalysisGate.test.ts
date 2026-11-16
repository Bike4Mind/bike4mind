import { describe, it, expect } from 'vitest';
import { SreAgentConfigSchema, SreSourceType } from '@bike4mind/common';
import { resolveDiagnosticianGate } from './sreAnalysisGate';

const baseGate = { enabled: true, autoThreshold: 85, askThreshold: 60 };
const { GITHUB_ISSUE, CLOUDWATCH } = SreSourceType;

describe('resolveDiagnosticianGate', () => {
  it.each([GITHUB_ISSUE, CLOUDWATCH])('asks for approval on high confidence with an empty allow-list (%s)', source => {
    expect(resolveDiagnosticianGate({ ...baseGate, autoDispatchSources: [] }, 95, source)).toBe('ask');
  });

  it.each([GITHUB_ISSUE, CLOUDWATCH])(
    'asks for approval when the gate is disabled and nothing is listed (%s)',
    source => {
      expect(resolveDiagnosticianGate({ ...baseGate, enabled: false, autoDispatchSources: [] }, 95, source)).toBe(
        'ask'
      );
    }
  );

  it('asks for approval when autoDispatchSources is undefined', () => {
    expect(resolveDiagnosticianGate(baseGate, 95, GITHUB_ISSUE)).toBe('ask');
  });

  it('auto-dispatches a listed source above and exactly at the threshold', () => {
    const gate = { ...baseGate, autoDispatchSources: [GITHUB_ISSUE] };
    expect(resolveDiagnosticianGate(gate, 95, GITHUB_ISSUE)).toBe('auto');
    expect(resolveDiagnosticianGate(gate, 85, GITHUB_ISSUE)).toBe('auto');
  });

  it('auto-dispatches a listed source when the gate is disabled', () => {
    const gate = { ...baseGate, enabled: false, autoDispatchSources: [GITHUB_ISSUE] };
    expect(resolveDiagnosticianGate(gate, 10, GITHUB_ISSUE)).toBe('auto');
  });

  it('does not leak a listed source to the other source', () => {
    expect(resolveDiagnosticianGate({ ...baseGate, autoDispatchSources: [GITHUB_ISSUE] }, 95, CLOUDWATCH)).toBe('ask');
    expect(resolveDiagnosticianGate({ ...baseGate, autoDispatchSources: [CLOUDWATCH] }, 95, GITHUB_ISSUE)).toBe('ask');
  });

  it.each([
    [[GITHUB_ISSUE], GITHUB_ISSUE],
    [[], GITHUB_ISSUE],
    [[CLOUDWATCH], CLOUDWATCH],
    [[], CLOUDWATCH],
  ])('keeps ask and stop bands unchanged (list %j, source %s)', (autoDispatchSources, source) => {
    const gate = { ...baseGate, autoDispatchSources };
    expect(resolveDiagnosticianGate(gate, 84, source)).toBe('ask');
    expect(resolveDiagnosticianGate(gate, 60, source)).toBe('ask');
    expect(resolveDiagnosticianGate(gate, 59, source)).toBe('stop');
  });
});

describe('SreAgentConfigSchema autoDispatchSources', () => {
  it('defaults to an empty list for stored gate configs without the field', () => {
    const parsed = SreAgentConfigSchema.parse({
      repos: [
        {
          owner: 'acme',
          repo: 'app',
          gates: {
            diagnosticianToSurgeon: { enabled: true, autoThreshold: 90, askThreshold: 50, approvalTimeoutHours: 6 },
          },
        },
      ],
    });
    expect(parsed.repos[0].gates.diagnosticianToSurgeon.autoDispatchSources).toEqual([]);
    expect(parsed.repos[0].gates.sentinelToDiagnostician.autoDispatchSources).toEqual([]);
  });
});
