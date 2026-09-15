import { afterEach, describe, expect, it, vi } from 'vitest';
import { notifyToolFinish, setToolFinishObserver } from './toolFinishObserver';

// Module-level state: clear it so tests cannot leak an observer into each other.
afterEach(() => setToolFinishObserver(null));

describe('tool-finish observer seam', () => {
  it('delivers the observation to a registered observer', () => {
    const observer = vi.fn();
    setToolFinishObserver(observer);

    notifyToolFinish({ toolName: 'web_search', userId: 'u1' });

    expect(observer).toHaveBeenCalledWith({ toolName: 'web_search', userId: 'u1' });
  });

  it('is a no-op when no observer is registered', () => {
    expect(() => notifyToolFinish({ toolName: 'web_fetch' })).not.toThrow();
  });

  it('swallows an observer throw so a tool call can never be broken by it', () => {
    setToolFinishObserver(() => {
      throw new Error('observer blew up');
    });

    expect(() => notifyToolFinish({ toolName: 'math_evaluate', userId: 'u1' })).not.toThrow();
  });

  it('stops delivering once cleared', () => {
    const observer = vi.fn();
    setToolFinishObserver(observer);
    setToolFinishObserver(null);

    notifyToolFinish({ toolName: 'wolfram_alpha' });

    expect(observer).not.toHaveBeenCalled();
  });
});
