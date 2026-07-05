import { describe, it, expect } from 'vitest';
import { isMonitoredStage } from '../stageGating.js';

const MONITORED = ['dev', 'production'] as const;

describe('isMonitoredStage', () => {
  it('returns true when stage is in monitoredStages', () => {
    expect(isMonitoredStage('dev', MONITORED)).toBe(true);
    expect(isMonitoredStage('production', MONITORED)).toBe(true);
  });

  it('returns false when stage is NOT in monitoredStages', () => {
    expect(isMonitoredStage('pr-42', MONITORED)).toBe(false);
    expect(isMonitoredStage('staging', MONITORED)).toBe(false);
  });

  it('returns true when envOverride is "true" regardless of stage', () => {
    expect(isMonitoredStage('pr-42', MONITORED, 'true')).toBe(true);
    expect(isMonitoredStage('local', [], 'true')).toBe(true);
  });

  it('returns true when envOverride is "true" and stage is already in monitored list', () => {
    expect(isMonitoredStage('dev', MONITORED, 'true')).toBe(true);
  });

  it('returns false when monitoredStages is empty and no override', () => {
    expect(isMonitoredStage('dev', [])).toBe(false);
  });

  it('returns false when monitoredStages is undefined and no override', () => {
    expect(isMonitoredStage('dev', undefined)).toBe(false);
  });
});
