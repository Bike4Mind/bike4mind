import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { MAX_STORAGE_LIMIT_MB } from '@bike4mind/common';
import OrganizationStorageLimitField, { parseStorageLimitInput } from './OrganizationStorageLimitField';

const useOrgStorageUsage = vi.fn();
vi.mock('@client/app/hooks/data/useOrgStorageUsage', () => ({
  useOrgStorageUsage: (orgId: string) => useOrgStorageUsage(orgId),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('parseStorageLimitInput', () => {
  it('reads empty (or whitespace) as a cleared override', () => {
    expect(parseStorageLimitInput('')).toEqual({ valid: true, storageLimit: null });
    expect(parseStorageLimitInput('  ')).toEqual({ valid: true, storageLimit: null });
  });

  it('keeps fractional MB instead of truncating', () => {
    expect(parseStorageLimitInput('0.5')).toEqual({ valid: true, storageLimit: 0.5 });
    expect(parseStorageLimitInput('0')).toEqual({ valid: true, storageLimit: 0 });
  });

  it('rejects negative, malformed and out-of-range input', () => {
    expect(parseStorageLimitInput('-1')).toEqual({ valid: false });
    expect(parseStorageLimitInput('abc')).toEqual({ valid: false });
    expect(parseStorageLimitInput('5e')).toEqual({ valid: false });
    expect(parseStorageLimitInput(String(MAX_STORAGE_LIMIT_MB + 1))).toEqual({ valid: false });
    expect(parseStorageLimitInput('1e303')).toEqual({ valid: false });
  });
});

describe('OrganizationStorageLimitField', () => {
  beforeEach(() => {
    useOrgStorageUsage.mockReset();
    useOrgStorageUsage.mockReturnValue({ data: { usedBytes: 2_500_000, limitBytes: 10_000_000_000 }, isError: false });
  });

  it('shows usage against the effective limit and the default that applies when empty', () => {
    render(<OrganizationStorageLimitField orgId="org1" value="" onChange={vi.fn()} />, { wrapper: Wrapper });

    expect(useOrgStorageUsage).toHaveBeenCalledWith('org1');
    const usage = screen.getByTestId('admin-org-storage-usage').textContent;
    expect(usage).toContain('2.5 MB / 10 GB used');
    expect(usage).toContain('default (10,000 MB)');
  });

  it('reports each edit to the parent', () => {
    const onChange = vi.fn();
    render(<OrganizationStorageLimitField orgId="org1" value="" onChange={onChange} />, { wrapper: Wrapper });

    fireEvent.change(screen.getByTestId('admin-org-storage-limit-input'), { target: { value: '0.5' } });

    expect(onChange).toHaveBeenCalledWith('0.5');
  });

  it('flags an invalid value', () => {
    render(<OrganizationStorageLimitField orgId="org1" value="-3" onChange={vi.fn()} />, { wrapper: Wrapper });

    expect(screen.getByTestId('admin-org-storage-usage').textContent).toContain('Enter a number of MB from 0 to');
  });
});
