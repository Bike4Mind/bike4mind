import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useCliStore } from '../store/index.js';
import { whenTurnIdle } from './whenTurnIdle';

const nextMacrotask = () => new Promise(resolve => setImmediate(resolve));

describe('whenTurnIdle', () => {
  beforeEach(() => {
    useCliStore.getState().setIsThinking(false);
  });

  it('runs at once when no turn is in flight', () => {
    const callback = vi.fn();
    whenTurnIdle(callback);

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('waits for the running turn to end', async () => {
    const callback = vi.fn();
    useCliStore.getState().setIsThinking(true);
    whenTurnIdle(callback);
    await nextMacrotask();
    expect(callback).not.toHaveBeenCalled();

    useCliStore.getState().setIsThinking(false);
    await nextMacrotask();

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('keeps waiting through the gap between auto-compaction and its turn', async () => {
    const callback = vi.fn();
    useCliStore.getState().setIsThinking(true);
    whenTurnIdle(callback);

    // turnController drops isThinking after compaction and raises it again synchronously.
    useCliStore.getState().setIsThinking(false);
    useCliStore.getState().setIsThinking(true);
    await nextMacrotask();
    expect(callback).not.toHaveBeenCalled();

    useCliStore.getState().setIsThinking(false);
    await nextMacrotask();

    expect(callback).toHaveBeenCalledTimes(1);
  });
});
