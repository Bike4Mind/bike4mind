import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveWsDebugChipVisible } from './wsDebugChip';

describe('resolveWsDebugChipVisible', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is hidden by default (no param, no stored flag)', () => {
    expect(resolveWsDebugChipVisible('')).toBe(false);
    expect(resolveWsDebugChipVisible('?foo=bar')).toBe(false);
  });

  it('shows and sticks the flag when ?debug=ws is present', () => {
    expect(resolveWsDebugChipVisible('?debug=ws')).toBe(true);
    expect(sessionStorage.getItem('debug-ws')).toBe('1');
  });

  it('stays visible across SPA navigation that drops the query param', () => {
    resolveWsDebugChipVisible('?debug=ws'); // enabled once (e.g. on hard load)
    // subsequent in-app navigations arrive with no debug param
    expect(resolveWsDebugChipVisible('')).toBe(true);
    expect(resolveWsDebugChipVisible('?tab=projects')).toBe(true);
  });

  it('?debug=off clears the flag and hides the chip', () => {
    resolveWsDebugChipVisible('?debug=ws');
    expect(resolveWsDebugChipVisible('?debug=off')).toBe(false);
    expect(sessionStorage.getItem('debug-ws')).toBeNull();
    // stays hidden on later param-less navigations
    expect(resolveWsDebugChipVisible('')).toBe(false);
  });

  it('an unrelated debug value does not enable the chip', () => {
    expect(resolveWsDebugChipVisible('?debug=perf')).toBe(false);
    expect(sessionStorage.getItem('debug-ws')).toBeNull();
  });

  it('degrades gracefully when sessionStorage throws (private mode / blocked)', () => {
    const boom = () => {
      throw new Error('storage blocked');
    };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(boom);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(boom);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(boom);
    // honors the in-URL param for the current view, never throws
    expect(resolveWsDebugChipVisible('?debug=ws')).toBe(true);
    // no param -> stays hidden rather than crashing the mount effect
    expect(resolveWsDebugChipVisible('')).toBe(false);
    expect(resolveWsDebugChipVisible('?debug=off')).toBe(false);
  });
});
