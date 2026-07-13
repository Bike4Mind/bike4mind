import { describe, expect, it } from 'vitest';
import { CONTEXT_TELEMETRY_SCHEMA_VERSION, ToolTelemetrySchema } from './contextTelemetry';

describe('ToolTelemetrySchema web_fetch size fields (issue #452)', () => {
  const base = {
    toolName: 'web_fetch',
    isMcpTool: false,
    invocationCount: 2,
    successCount: 2,
    failureCount: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
    retryCount: 0,
  };

  it('accepts the new truncation/size fields', () => {
    const parsed = ToolTelemetrySchema.parse({
      ...base,
      truncatedInvocationCount: 1,
      maxExtractedChars: 50000,
      totalExtractedChars: 60000,
    });
    expect(parsed.truncatedInvocationCount).toBe(1);
    expect(parsed.maxExtractedChars).toBe(50000);
    expect(parsed.totalExtractedChars).toBe(60000);
  });

  it('leaves the fields optional (back-compat with pre-1.2 entries)', () => {
    const parsed = ToolTelemetrySchema.parse(base);
    expect(parsed.truncatedInvocationCount).toBeUndefined();
  });

  it('bumped the schema version to 1.2', () => {
    expect(CONTEXT_TELEMETRY_SCHEMA_VERSION).toBe('1.2');
  });
});
