// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, renderHook, act } from '@testing-library/react';
import type { PublishResult } from '@bike4mind/common';

const captured = vi.hoisted(() => ({ props: undefined as Record<string, unknown> | undefined }));

vi.mock('@client/app/components/common/PublishShareModal', () => ({
  PublishShareModal: (props: Record<string, unknown>) => {
    captured.props = props;
    return null;
  },
}));

import { usePublishShare } from './usePublishShare';

describe('usePublishShare', () => {
  it('passes the published-lookup callback through to the dialog', () => {
    const { result } = renderHook(() => usePublishShare());
    render(<>{result.current.modal}</>);
    const resolvePublished = vi.fn<[], Promise<PublishResult | null>>();
    act(() => {
      result.current.publishAndShare({ publish: vi.fn(), title: 'T', resolvePublished });
    });
    render(<>{result.current.modal}</>);
    expect(captured.props?.open).toBe(true);
    expect(captured.props?.resolvePublished).toBe(resolvePublished);
  });
});
