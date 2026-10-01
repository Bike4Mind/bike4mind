import { describe, it, expect, vi } from 'vitest';

vi.mock('sst', () => ({ Resource: {} }));

describe('alarmToSlack entry point', () => {
  it('exports the dlqAlarmToSlack handler under the path external alarm topics subscribe to', async () => {
    const entry = await import('./alarmToSlack');
    const implementation = await import('./dlqAlarmToSlack');
    expect(entry.handler).toBe(implementation.handler);
  });
});
