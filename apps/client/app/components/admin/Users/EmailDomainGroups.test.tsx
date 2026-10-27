import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { describe, expect, it, vi } from 'vitest';
import { EmailDomainGroups } from './EmailDomainGroups';
import { AnomalyBanner } from './AnomalyBanner';

const theme = extendTheme({ ...getThemeConfig() });
const group = {
  domain: 'example.test',
  userIds: ['a', 'b'],
  count: 2,
  firstCreatedAt: '2026-01-01T00:00:00Z',
  lastCreatedAt: '2026-01-01T00:02:00Z',
  apiKeyCount: 3,
  likelyAutomated: true,
};

describe('signup review UI', () => {
  it('passes group account IDs to the existing bulk selection interface', () => {
    const toggle = vi.fn();
    render(
      <CssVarsProvider theme={theme}>
        <EmailDomainGroups
          groups={[group]}
          loading={false}
          onRetry={vi.fn()}
          selection={{ selectedIds: new Set(['a']), onToggle: vi.fn(), onTogglePage: toggle }}
        />
      </CssVarsProvider>
    );
    fireEvent.click(screen.getByTestId('users-domain-select-example.test'));
    expect(toggle).toHaveBeenCalledWith(['a', 'b'], true);
    expect(screen.getByTestId('users-domain-table').textContent).toContain('Likely automated');
    expect(screen.getByTestId('users-domain-table').textContent).toContain('2 min');
  });

  it('only shows the banner for a spike or an incomplete scan, and offers review', () => {
    const onReview = vi.fn();
    const snapshot = {
      since: '',
      until: '',
      signupCount: 1,
      apiKeyCount: 3,
      signupSpike: false,
      apiKeySpike: false,
      truncated: false,
      topDomain: 'example.test',
    };
    const { rerender } = render(
      <CssVarsProvider theme={theme}>
        <AnomalyBanner snapshot={snapshot} onReview={onReview} />
      </CssVarsProvider>
    );
    expect(screen.queryByTestId('users-anomaly-banner')).toBeNull();
    rerender(
      <CssVarsProvider theme={theme}>
        <AnomalyBanner snapshot={{ ...snapshot, apiKeySpike: true }} onReview={onReview} />
      </CssVarsProvider>
    );
    fireEvent.click(screen.getByTestId('users-review-cluster-btn'));
    expect(onReview).toHaveBeenCalledOnce();
  });
});
