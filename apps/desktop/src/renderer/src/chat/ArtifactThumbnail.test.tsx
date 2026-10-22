// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MermaidResult } from './mermaidDiagram';
import type { ChatArtifactView } from '@shared/chat';
import { ArtifactThumbnail } from './ArtifactThumbnail';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const renderMermaidDiagram = vi.fn(async (source: string): Promise<MermaidResult> => ({
  ok: true as const,
  svg: `<svg><text>${source}</text></svg>`,
}));
vi.mock('./mermaidDiagram', () => ({ renderMermaidDiagram: (source: string) => renderMermaidDiagram(source) }));

const diagram = (content: string) => ({ id: 'd1', type: 'mermaid', title: 'Flow', content }) as ChatArtifactView;

describe('ArtifactThumbnail', () => {
  beforeEach(() => {
    renderMermaidDiagram.mockClear();
  });
  it('redraws a cached diagram whose source changed under the same id', async () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    const drawn = () => decodeURIComponent(host.querySelector('img')?.getAttribute('src') ?? '');

    await act(async () => root.render(<ArtifactThumbnail artifact={diagram('graph A')} mode="light" />));
    expect(drawn()).toContain('graph A');

    await act(async () => root.render(<ArtifactThumbnail artifact={diagram('graph B')} mode="light" />));
    expect(renderMermaidDiagram).toHaveBeenCalledTimes(2);
    expect(drawn()).toContain('graph B');

    act(() => root.unmount());
  });
  it('retries a failed diagram render when the thumbnail is mounted again', async () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    const artifact = { ...diagram('flowchart TD; A --> B'), id: 'retry-diagram' };
    renderMermaidDiagram.mockResolvedValueOnce({ ok: false, reason: 'invalid' });

    try {
      await act(async () => root.render(<ArtifactThumbnail artifact={artifact} mode="light" />));
      expect(host.querySelector('[data-testid="artifact-library-thumb-source"]')).not.toBeNull();
      await act(async () => root.render(null));
      await act(async () => root.render(<ArtifactThumbnail artifact={artifact} mode="light" />));

      expect(renderMermaidDiagram).toHaveBeenCalledTimes(2);
      expect(host.querySelector('img')).not.toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });
});
