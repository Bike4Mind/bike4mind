// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { ChatArtifactView } from '@shared/chat';
import { ArtifactThumbnail } from './ArtifactThumbnail';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const renderMermaidDiagram = vi.fn(async (source: string) => ({
  ok: true as const,
  svg: `<svg><text>${source}</text></svg>`,
}));
vi.mock('./mermaidDiagram', () => ({ renderMermaidDiagram: (source: string) => renderMermaidDiagram(source) }));

const diagram = (content: string) => ({ id: 'd1', type: 'mermaid', title: 'Flow', content }) as ChatArtifactView;

describe('ArtifactThumbnail', () => {
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
});
