import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const hoisted = vi.hoisted(() => ({ setSessionFilesOpen: vi.fn() }));

vi.mock('@client/app/components/Session/AISettings/FilesSection', () => ({
  default: () => <div data-testid="files-section" />,
}));
vi.mock('@client/app/components/Session/AdvancedAISettings', () => ({
  useAdvancedAISettings: (select: (s: { setSessionFilesOpen: typeof hoisted.setSessionFilesOpen }) => unknown) =>
    select({ setSessionFilesOpen: hoisted.setSessionFilesOpen }),
}));

import NotebookFilesChip from './NotebookFilesChip';

const appTheme = extendTheme({ ...getThemeConfig() });

const Harness = ({ count, isMobile = false }: { count: number; isMobile?: boolean }) => {
  const [open, setOpen] = React.useState(false);
  return (
    <CssVarsProvider theme={appTheme}>
      <NotebookFilesChip
        totalFilesCount={count}
        hasEmbeddingMismatches={false}
        model="gpt-4.1-2025-04-14"
        isMobile={isMobile}
        open={open}
        setOpen={setOpen}
      />
    </CssVarsProvider>
  );
};

describe('NotebookFilesChip', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders nothing while the notebook has no files', () => {
    render(<Harness count={0} />);
    expect(screen.queryByTestId('session-files-btn')).toBeNull();
  });

  it('counts the files, singular for one', () => {
    const { rerender } = render(<Harness count={1} />);
    expect(screen.getByTestId('session-files-btn')).toHaveTextContent('1 notebook file');
    rerender(<Harness count={3} />);
    expect(screen.getByTestId('session-files-btn')).toHaveTextContent('3 notebook files');
  });

  it('opens the files panel on desktop, under a header that says what these files are', async () => {
    render(<Harness count={3} />);
    fireEvent.click(screen.getByTestId('session-files-btn'));
    expect(screen.getByTestId('notebook-files-header')).toHaveTextContent('Notebook files');
    expect(screen.getByTestId('files-section')).toBeInTheDocument();
    fireEvent.mouseOver(screen.getByTestId('notebook-files-info-btn'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/with every message in this notebook/);
  });

  it('opens the Session Files modal on a phone', () => {
    render(<Harness count={3} isMobile />);
    fireEvent.click(screen.getByTestId('session-files-btn'));
    expect(hoisted.setSessionFilesOpen).toHaveBeenCalledWith(true);
  });
});
