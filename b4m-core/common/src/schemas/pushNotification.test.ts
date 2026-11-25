import { describe, expect, it } from 'vitest';
import { isHeldDuringBusyBlock } from './pushNotification';

describe('isHeldDuringBusyBlock', () => {
  it('holds run results, which the block brief lists', () => {
    expect(isHeldDuringBusyBlock('agent_completed')).toBe(true);
    expect(isHeldDuringBusyBlock('agent_failed')).toBe(true);
  });

  it('does not hold agent_message, which writes no run the block brief could list', () => {
    expect(isHeldDuringBusyBlock('agent_message')).toBe(false);
  });
});
