import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({ connection: { current: null as Record<string, unknown> | null } }));

vi.mock('@client/app/hooks/data/googleDrive', () => ({
  useLakeDriveConnection: () => ({ data: h.connection.current }),
}));

import LakeDriveStatusChip from './LakeDriveStatusChip';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (ui: ReactNode) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);

const connection = {
  status: 'connected',
  lastError: null,
  folderName: 'Handbook',
  driveFolderId: 'FOLDER',
  lastPolledAt: '2026-01-01T11:00:00Z',
};

beforeEach(() => {
  h.connection.current = connection;
});

describe('LakeDriveStatusChip', () => {
  it('renders nothing with no connection', () => {
    h.connection.current = null;
    wrap(<LakeDriveStatusChip lakeId="lake1" organizationId="org-1" isCreator={false} />);
    expect(screen.queryByTestId('datalake-drive-status-chip-lake1')).toBeNull();
  });

  it('refreshes the relative last-synced time in the tooltip on every minute tick', () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T12:00:00Z') });
    try {
      wrap(<LakeDriveStatusChip lakeId="lake1" organizationId="org-1" isCreator={false} />);
      fireEvent.mouseOver(screen.getByTestId('datalake-drive-status-chip-lake1'));
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(screen.getByRole('tooltip')).toHaveTextContent('last synced an hour ago');
      act(() => {
        vi.advanceTimersByTime(60 * 60_000);
      });
      expect(screen.getByRole('tooltip')).toHaveTextContent('last synced 2 hours ago');
    } finally {
      vi.useRealTimers();
    }
  });
});
