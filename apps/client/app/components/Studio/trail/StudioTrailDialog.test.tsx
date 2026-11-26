import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import type { FileLineage } from '@server/files/fileLineage';
import { getThemeConfig } from '@client/app/utils/themes';

const LINEAGE: FileLineage = {
  fileId: 'take',
  ancestors: [
    {
      fileId: 'take',
      depth: 0,
      redacted: false,
      fileName: 'take.png',
      mimeType: 'image/png',
      generator: 'image',
      modelId: 'model-take',
      prompt: 'a lighthouse',
      url: 'https://files.example.invalid/take',
      createdAt: '2026-11-01T00:00:00.000Z',
      request: { prompt: 'a lighthouse' },
    },
  ],
  children: [],
  edges: [],
  truncated: false,
};

vi.mock('@client/app/hooks/data/fileLineage', () => ({
  useFileLineage: () => ({ isPending: false, isError: false, data: LINEAGE }),
}));

import StudioTrailDialog from './StudioTrailDialog';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('StudioTrailDialog', () => {
  it('renders the trail under its own Studio token scope, named by its heading', () => {
    render(<StudioTrailDialog fileId="take" open onClose={vi.fn()} />, { wrapper: TestWrapper });

    const scope = screen.getByTestId('studio-trail-dialog-scope');
    expect(scope).toHaveAttribute('data-studio-mode');
    expect(scope).toContainElement(screen.getByTestId('studio-trail'));
    expect(screen.getByRole('dialog', { name: 'Trail' })).toBe(screen.getByTestId('studio-trail-dialog'));
  });

  it('closes after a step is restored', () => {
    const onClose = vi.fn();
    const onRestore = vi.fn();
    render(<StudioTrailDialog fileId="take" open onClose={onClose} onRestore={onRestore} />, {
      wrapper: TestWrapper,
    });

    fireEvent.click(screen.getByTestId('studio-trail-step-take'));

    expect(onRestore).toHaveBeenCalledWith(expect.objectContaining({ medium: 'image' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders nothing while closed', () => {
    render(<StudioTrailDialog fileId="take" open={false} onClose={vi.fn()} />, { wrapper: TestWrapper });
    expect(screen.queryByTestId('studio-trail-dialog')).not.toBeInTheDocument();
  });
});
