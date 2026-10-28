import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import type { EmailDomainGroup } from '@client/app/utils/signupAnomaly';
import { DomainGroupHeader } from './DomainGroupHeader';

const theme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => <CssVarsProvider theme={theme}>{children}</CssVarsProvider>;

const group = (domain: string): EmailDomainGroup => ({
  domain,
  userIds: ['u1'],
  count: 1,
  firstCreatedAt: '2026-03-10T11:00:00.000Z',
  lastCreatedAt: '2026-03-10T11:00:00.000Z',
  apiKeyCount: 0,
  signals: [],
});

describe('DomainGroupHeader', () => {
  it('offers to filter to a real domain', () => {
    render(<DomainGroupHeader group={group('example.com')} filtered={false} onFilter={vi.fn()} />, {
      wrapper: Wrapper,
    });
    expect(screen.getByTestId('admin-users-group-example.com-filter-btn')).toBeTruthy();
  });

  it('hides the filter on the unknown bucket, which no domain filter can match', () => {
    render(<DomainGroupHeader group={group('(unknown)')} filtered={false} onFilter={vi.fn()} />, { wrapper: Wrapper });
    expect(screen.queryByTestId('admin-users-group-(unknown)-filter-btn')).toBeNull();
  });
});
