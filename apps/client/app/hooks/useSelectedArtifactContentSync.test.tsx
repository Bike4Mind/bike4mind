import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The store-sync guard shared by the Html/React/Code preview cards. An iterated artifact's
// v1/v2 cards share the same id, so a card mounting (or re-mounting on scroll) must not
// overwrite the shared store; only a change observed while mounted (live streaming) may push
// (#457).

const { setSessionLayout, getState } = vi.hoisted(() => ({
  setSessionLayout: vi.fn(),
  getState: vi.fn(),
}));

vi.mock('@client/app/hooks/useSessionLayout', () => {
  const hook = () => undefined;
  return { default: Object.assign(hook, { getState }), setSessionLayout };
});

import { useSelectedArtifactContentSync } from './useSelectedArtifactContentSync';

// Card is selected and showing '<old/>' for id 'a1'.
const selectedState = () => ({
  selectedArtifactId: 'a1',
  artifactData: { type: 'html', id: 'a1', mimeType: 'text/html', content: { id: 'a1', content: '<old/>' } },
});

const render = (id: string, type: string, key: string, obj: unknown) =>
  renderHook(({ k, o }) => useSelectedArtifactContentSync(id, type as any, k, o as any), {
    initialProps: { k: key, o: obj },
  });

describe('useSelectedArtifactContentSync (#457 guard)', () => {
  beforeEach(() => {
    setSessionLayout.mockClear();
    getState.mockReset();
    getState.mockImplementation(selectedState);
  });

  it('does not push on initial mount (scroll-in must not clobber)', () => {
    render('a1', 'html', '<v2/>', { id: 'a1', content: '<v2/>' });
    expect(setSessionLayout).not.toHaveBeenCalled();
  });

  it('pushes when the content key changes while mounted (live streaming)', () => {
    const { rerender } = render('a1', 'html', '<v2-partial/>', { id: 'a1', content: '<v2-partial/>' });
    expect(setSessionLayout).not.toHaveBeenCalled();

    rerender({ k: '<v2-final/>', o: { id: 'a1', content: '<v2-final/>' } });
    expect(setSessionLayout).toHaveBeenCalledTimes(1);
    expect(setSessionLayout.mock.calls[0][0].artifactData.content.content).toBe('<v2-final/>');
  });

  it('does not push when this artifact is not the selected one', () => {
    getState.mockImplementation(() => ({ selectedArtifactId: 'other', artifactData: null }));
    const { rerender } = render('a1', 'html', '<a/>', { id: 'a1', content: '<a/>' });
    rerender({ k: '<b/>', o: { id: 'a1', content: '<b/>' } });
    expect(setSessionLayout).not.toHaveBeenCalled();
  });

  it('does not push when the type does not match the selected artifact', () => {
    const { rerender } = render('a1', 'react', '<a/>', { id: 'a1', content: '<a/>' });
    rerender({ k: '<b/>', o: { id: 'a1', content: '<b/>' } });
    // Selected artifact is type 'html', hook is for 'react' -> never syncs.
    expect(setSessionLayout).not.toHaveBeenCalled();
  });

  it('a freshly mounted older card (new hook instance) does not clobber', () => {
    render('a1', 'html', '<v2/>', { id: 'a1', content: '<v2/>' }).unmount();
    setSessionLayout.mockClear();
    // Simulate scrolling the old v1 card into view: a brand-new mount with older content.
    render('a1', 'html', '<v1/>', { id: 'a1', content: '<v1/>' });
    expect(setSessionLayout).not.toHaveBeenCalled();
  });
});
