import type { ReactNode } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileLineage, VisibleLineageNode } from '@server/files/fileLineage';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  state: { isPending: false, isError: false, data: undefined as FileLineage | undefined },
}));

vi.mock('@client/app/hooks/data/fileLineage', () => ({ useFileLineage: () => h.state }));

import StudioTrail from './StudioTrail';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const visible = (fileId: string, depth: number, overrides: Partial<VisibleLineageNode> = {}): VisibleLineageNode => ({
  fileId,
  depth,
  redacted: false,
  fileName: `${fileId}.png`,
  mimeType: 'image/png',
  generator: 'image',
  modelId: `model-${fileId}`,
  prompt: `prompt ${fileId}`,
  url: `https://files.example.invalid/${fileId}`,
  createdAt: '2026-11-01T00:00:00.000Z',
  request: { prompt: `prompt ${fileId}` },
  ...overrides,
});

const LINEAGE: FileLineage = {
  fileId: 'take',
  ancestors: [
    visible('take', 0),
    visible('source', 1),
    { fileId: 'hidden', depth: 1, redacted: true },
    visible('upload', 2, { generator: null, modelId: null, prompt: null, request: null }),
  ],
  children: [visible('child', -1)],
  edges: [
    { parentId: 'source', childId: 'take', role: 'variation_of' },
    { parentId: 'hidden', childId: 'take', role: 'style' },
    { parentId: 'upload', childId: 'source', role: 'first_frame' },
    { parentId: 'take', childId: 'child', role: 'reference' },
  ],
  truncated: false,
};

beforeEach(() => {
  h.state = { isPending: false, isError: false, data: LINEAGE };
});

describe('StudioTrail', () => {
  it('lists the ancestry oldest first with each role on its edge', () => {
    render(<StudioTrail fileId="take" onRestore={vi.fn()} />, { wrapper: TestWrapper });

    const steps = within(screen.getByTestId('studio-trail-ancestors')).getAllByTestId(/^studio-trail-(step|redacted)-/);
    expect(steps.map(step => step.getAttribute('data-testid'))).toEqual([
      'studio-trail-step-upload',
      'studio-trail-step-source',
      'studio-trail-redacted-hidden',
      'studio-trail-step-take',
    ]);
    expect(screen.getByTestId('studio-trail-roles-upload')).toHaveTextContent('First frame');
    expect(screen.getByTestId('studio-trail-roles-source')).toHaveTextContent('Variation of');
    expect(screen.getByTestId('studio-trail-roles-hidden')).toHaveTextContent('Style');
    expect(screen.queryByTestId('studio-trail-roles-take')).not.toBeInTheDocument();
  });

  it('shows an unreadable ancestor as a placeholder', () => {
    render(<StudioTrail fileId="take" />, { wrapper: TestWrapper });
    expect(screen.getByTestId('studio-trail-redacted-hidden')).toHaveTextContent('Not available');
  });

  it('restores a step with its stored request, medium and the names of the files it can read', () => {
    const onRestore = vi.fn();
    render(<StudioTrail fileId="take" onRestore={onRestore} />, { wrapper: TestWrapper });

    fireEvent.click(screen.getByTestId('studio-trail-step-source'));

    expect(onRestore).toHaveBeenCalledWith({
      medium: 'image',
      request: { prompt: 'prompt source' },
      fileNames: {
        take: 'take.png',
        source: 'source.png',
        hidden: null,
        upload: 'upload.png',
        child: 'child.png',
      },
    });
  });

  it('does not offer restore for a step without a stored request, or without onRestore', () => {
    const { unmount } = render(<StudioTrail fileId="take" onRestore={vi.fn()} />, { wrapper: TestWrapper });
    expect(screen.getByTestId('studio-trail-step-upload')).toHaveAttribute('data-restorable', 'false');
    unmount();

    render(<StudioTrail fileId="take" />, { wrapper: TestWrapper });
    expect(screen.getByTestId('studio-trail-step-source')).toHaveAttribute('data-restorable', 'false');
  });

  it('lists the files made from the take with their role', () => {
    render(<StudioTrail fileId="take" />, { wrapper: TestWrapper });
    expect(within(screen.getByTestId('studio-trail-children')).getByTestId('studio-trail-step-child')).toBeVisible();
    expect(screen.getByTestId('studio-trail-roles-child')).toHaveTextContent('Reference');
  });

  it('says when the walk was cut short', () => {
    h.state = { ...h.state, data: { ...LINEAGE, truncated: true } };
    render(<StudioTrail fileId="take" />, { wrapper: TestWrapper });
    expect(screen.getByTestId('studio-trail-truncated')).toBeInTheDocument();
  });

  it('shows loading and error states', () => {
    h.state = { isPending: true, isError: false, data: undefined };
    const { rerender } = render(<StudioTrail fileId="take" />, { wrapper: TestWrapper });
    expect(screen.getByTestId('studio-trail-loading')).toBeInTheDocument();

    h.state = { isPending: false, isError: true, data: undefined };
    rerender(<StudioTrail fileId="take" />);
    expect(screen.getByTestId('studio-trail-error')).toBeInTheDocument();
  });
});
