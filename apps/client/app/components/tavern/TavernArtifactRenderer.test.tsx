import { render, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import mermaid from 'mermaid';
import { getThemeConfig } from '@client/app/utils/themes';
import { mermaidOptions } from '@client/app/utils/mermaidSecurity';
import TavernArtifactRenderer from './TavernArtifactRenderer';

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(),
  },
}));

vi.mock('../Charts/MermaidChart', () => ({ default: () => null }));

const appTheme = extendTheme({ ...getThemeConfig() });
const renderPreview = (definition: string) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <TavernArtifactRenderer artifact={{ type: 'mermaid', data: definition }} />
    </CssVarsProvider>
  );

describe('TavernArtifactRenderer compact mermaid preview', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(300);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('initializes mermaid with the shared options', () => {
    renderPreview('graph TD\n  A-->B');
    expect(mermaid.initialize).toHaveBeenCalledWith(mermaidOptions(false));
  });

  it('mounts the rendered svg without its remote references', async () => {
    vi.mocked(mermaid.render).mockResolvedValueOnce({
      svg: '<svg viewBox="0 0 10 10"><image href="https://example.com/i.png" /><rect /></svg>',
    } as Awaited<ReturnType<typeof mermaid.render>>);

    const { container } = renderPreview('graph TD\n  A-->B');

    await waitFor(() => expect(container.querySelector('rect')).not.toBeNull());
    expect(container.innerHTML).not.toContain('example.com');
  });

  it('logs and skips rendering a definition that loads a remote image', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { container } = renderPreview('flowchart TD\n  A@{ img: "https://example.com/p.png" }');

    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(mermaid.render).not.toHaveBeenCalled();
    expect(container.querySelector('svg')).toBeNull();
  });
});
