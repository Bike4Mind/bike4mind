import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
const query = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-query', () => ({ useQuery: query }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn() } }));
import OrganizationAuditSection from './OrganizationAuditSection';
const theme = extendTheme({ ...getThemeConfig() });
describe('organization audit section', () => {
  it('renders events and requires valid export dates', () => {
    query.mockReturnValue({
      data: {
        events: [{ id: '1', actorUserId: 'actor', action: 'policy.updated', occurredAt: '2026-01-01Z' }],
        nextCursor: null,
      },
      isPending: false,
      isError: false,
    });
    render(
      <CssVarsProvider theme={theme}>
        <OrganizationAuditSection organizationId="org" />
      </CssVarsProvider>
    );
    expect(screen.getByTestId('organization-audit-table').textContent).toContain('policy.updated');
    const exportButton = screen.getByTestId('organization-audit-export-btn');
    expect(exportButton).toBeDisabled();
    for (const id of ['from', 'to']) {
      const input = screen.getByTestId(`organization-audit-${id}-input`).querySelector('input')!;
      fireEvent.change(input, { target: { value: '2026-01-01' } });
    }
    expect(exportButton).toBeEnabled();
  });
});
