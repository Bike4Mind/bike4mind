import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { FilterChip } from './FilterChip';
import { ViewTabs } from './ViewTabs';
import { InitialsAvatar, initialsOf } from './InitialsAvatar';

const theme = extendTheme({ ...getThemeConfig() });
const OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'suspended', label: 'Suspended' },
];

function StatusFilter() {
  const [value, setValue] = useState<string>();
  return (
    <CssVarsProvider theme={theme}>
      <FilterChip id="status" label="Status" value={value} options={OPTIONS} onChange={setValue} />
    </CssVarsProvider>
  );
}

describe('FilterChip', () => {
  it('reads as the label while unset, then label and value with a remove button', () => {
    render(<StatusFilter />);
    expect(screen.getByTestId('admin-filter-status')).toHaveTextContent('Status');
    expect(screen.queryByTestId('admin-filter-clear-status-btn')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('admin-filter-status'));
    fireEvent.click(screen.getByTestId('admin-filter-status-suspended'));
    expect(screen.getByTestId('admin-filter-status')).toHaveTextContent('Status: Suspended');

    fireEvent.click(screen.getByTestId('admin-filter-clear-status-btn'));
    expect(screen.getByTestId('admin-filter-status')).toHaveTextContent(/^Status$/);
  });
});

describe('ViewTabs', () => {
  it('marks the active tab, shows counts and reports a pick', () => {
    const picked: string[] = [];
    render(
      <CssVarsProvider theme={theme}>
        <ViewTabs
          views={[
            { id: 'all', label: 'All', count: 1204 },
            { id: 'risk', label: 'High risk', count: 3 },
          ]}
          activeId="all"
          onSelect={id => picked.push(id)}
        />
      </CssVarsProvider>
    );
    expect(screen.getByTestId('admin-view-tabs-all-btn')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('admin-view-tabs-all-count')).toHaveTextContent('1,204');
    fireEvent.click(screen.getByTestId('admin-view-tabs-risk-btn'));
    expect(picked).toEqual(['risk']);
  });
});

describe('InitialsAvatar', () => {
  it('takes two initials from a name and falls back to the email', () => {
    expect(initialsOf('Ada  Lovelace King', 'x')).toBe('AL');
    expect(initialsOf('', 'zed@example.com')).toBe('Z');
    render(
      <CssVarsProvider theme={theme}>
        <InitialsAvatar name="Grace Hopper" fallback="g@example.com" seed="1" />
      </CssVarsProvider>
    );
    expect(screen.getByText('GH')).toBeInTheDocument();
  });
});

describe('FilterChip with several values', () => {
  function OrgFilter() {
    const [value, setValue] = useState<string[]>([]);
    return (
      <CssVarsProvider theme={theme}>
        <FilterChip
          multiple
          id="org"
          label="Organization"
          value={value}
          options={[
            { value: 'Acme', label: 'Acme' },
            { value: 'Globex', label: 'Globex' },
          ]}
          onChange={setValue}
        />
      </CssVarsProvider>
    );
  }

  it('toggles values and summarizes them', () => {
    render(<OrgFilter />);
    fireEvent.click(screen.getByTestId('admin-filter-org'));
    fireEvent.click(screen.getByTestId('admin-filter-org-Acme'));
    fireEvent.click(screen.getByTestId('admin-filter-org'));
    fireEvent.click(screen.getByTestId('admin-filter-org-Globex'));
    expect(screen.getByTestId('admin-filter-org')).toHaveTextContent('Organization: Acme +1');
    fireEvent.click(screen.getByTestId('admin-filter-clear-org-btn'));
    expect(screen.getByTestId('admin-filter-org')).toHaveTextContent(/^Organization$/);
  });
});
