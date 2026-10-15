import { describe, expect, it } from 'vitest';
import { buildToolInvocationTelemetry } from './toolInvocationTelemetry';

describe('buildToolInvocationTelemetry', () => {
  it('counts a call recorded as failed as a failure, not a success', () => {
    const telemetry = buildToolInvocationTelemetry(
      [{ name: 'math_evaluate', success: false }, { name: 'math_evaluate', success: false }, { name: 'math_evaluate' }],
      new Map()
    );
    expect(telemetry.get('math_evaluate')).toMatchObject({ invocationCount: 3, successCount: 1, failureCount: 2 });
  });

  it('keeps the higher of recorded and validator failure counts', () => {
    const calls = [
      { name: 'web_search', success: false },
      { name: 'web_search', success: true },
    ];
    expect(
      buildToolInvocationTelemetry(calls, new Map([['web_search', { available: true, failureCount: 0 }]])).get(
        'web_search'
      )
    ).toMatchObject({ successCount: 1, failureCount: 1 });

    const lowered = buildToolInvocationTelemetry(
      calls,
      new Map([['web_search', { available: false, failureCount: 2, lastError: 'timeout after 30s' }]])
    ).get('web_search');
    expect(lowered).toMatchObject({ invocationCount: 2, successCount: 0, failureCount: 2 });
    expect(lowered?.lastError).toContain('timeout');
    expect(lowered?.errorCategories).toHaveLength(1);
  });

  it('adds a tool that only failed validation', () => {
    const telemetry = buildToolInvocationTelemetry(
      [],
      new Map([['weather_info', { available: false, failureCount: 3, lastError: 'rate limit' }]])
    );
    expect(telemetry.get('weather_info')).toMatchObject({ invocationCount: 3, successCount: 0, failureCount: 3 });
  });

  it('flags MCP tools by name', () => {
    const telemetry = buildToolInvocationTelemetry([{ name: 'github:create_issue' }], new Map());
    expect(telemetry.get('github:create_issue')).toMatchObject({ isMcpTool: true, mcpServerName: 'github' });
  });
});
