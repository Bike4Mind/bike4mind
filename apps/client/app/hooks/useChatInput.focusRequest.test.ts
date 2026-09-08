import { describe, it, expect, beforeEach } from 'vitest';
import { useChatInput } from './useChatInput';

describe('useChatInput - requestFocus', () => {
  beforeEach(() => {
    useChatInput.setState({ focusRequestId: 0 });
  });

  it('bumps focusRequestId on each call so consumers watching it as a dep see a change', () => {
    expect(useChatInput.getState().focusRequestId).toBe(0);
    useChatInput.getState().requestFocus();
    expect(useChatInput.getState().focusRequestId).toBe(1);
    useChatInput.getState().requestFocus();
    expect(useChatInput.getState().focusRequestId).toBe(2);
  });
});
