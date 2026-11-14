import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useConsumeStudioRestore, useStudioRestore } from './studioRestore';

const REQUEST = { medium: 'video' as const, request: { prompt: 'waves' }, lineageInputs: [], fileNames: {} };

describe('useConsumeStudioRestore', () => {
  beforeEach(() => useStudioRestore.setState({ pending: null }));

  it('applies a restore aimed at its medium once, then clears it', () => {
    const apply = vi.fn();
    const { rerender } = renderHook(({ handler }) => useConsumeStudioRestore('video', handler), {
      initialProps: { handler: apply },
    });

    act(() => useStudioRestore.getState().requestRestore(REQUEST));
    // A new handler re-runs the effect; the restore must not apply twice.
    rerender({ handler: apply.bind(null) });

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(expect.objectContaining(REQUEST));
    expect(useStudioRestore.getState().pending).toBeNull();
  });

  it('leaves a restore for another medium pending until that form mounts', () => {
    const imageApply = vi.fn();
    renderHook(() => useConsumeStudioRestore('image', imageApply));
    act(() => useStudioRestore.getState().requestRestore(REQUEST));

    expect(imageApply).not.toHaveBeenCalled();
    expect(useStudioRestore.getState().pending).toMatchObject(REQUEST);

    const videoApply = vi.fn();
    renderHook(() => useConsumeStudioRestore('video', videoApply));
    expect(videoApply).toHaveBeenCalledTimes(1);
  });
});
