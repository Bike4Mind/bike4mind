import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { GITHUB_LAKE_FILE_RULES } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import GitHubLakeSyncRulesModal from './GitHubLakeSyncRulesModal';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (ui: ReactNode) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);

describe('GitHubLakeSyncRulesModal', () => {
  it('renders nothing while closed', () => {
    wrap(<GitHubLakeSyncRulesModal open={false} onClose={vi.fn()} />);
    expect(screen.queryByTestId('github-sync-rules-modal')).toBeNull();
  });

  it('lists the synced types, skipped folders and the candidate limit when open', () => {
    wrap(<GitHubLakeSyncRulesModal open onClose={vi.fn()} />);

    expect(screen.getByTestId('github-sync-rules-extensions')).toHaveTextContent('.md');
    expect(screen.getByTestId('github-sync-rules-folders')).toHaveTextContent('node_modules');
    expect(screen.getByTestId('github-sync-rules-limits')).toHaveTextContent(
      `more than ${GITHUB_LAKE_FILE_RULES.maxCandidates} matching files`
    );
    expect(GITHUB_LAKE_FILE_RULES.maxCandidates).toBe(5000);
  });

  it('calls onClose when dismissed', () => {
    const onClose = vi.fn();
    wrap(<GitHubLakeSyncRulesModal open onClose={onClose} />);
    fireEvent.keyDown(screen.getByTestId('github-sync-rules-modal'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
