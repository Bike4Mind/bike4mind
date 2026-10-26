import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ISignupMeta } from '@bike4mind/common';
import { describe, expect, it } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import SignupNetworkDetails from './SignupNetworkDetails';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderMeta = (overrides: Partial<ISignupMeta> = {}) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <SignupNetworkDetails
        signupMeta={{
          ip: '203.0.113.7',
          userAgent: 'Mozilla/5.0',
          asn: 16509,
          asnOrg: 'Amazon AWS',
          country: 'US',
          isDatacenter: true,
          capturedAt: new Date('2026-10-23T00:00:00Z'),
          ...overrides,
        }}
      />
    </CssVarsProvider>
  );

describe('SignupNetworkDetails', () => {
  it('shows the signup IP, network and country, and flags a datacenter network', () => {
    renderMeta();

    expect(screen.getByTestId('signup-network-ip').textContent).toBe('203.0.113.7');
    expect(screen.getByTestId('signup-network-asn').textContent).toContain('AS16509 (Amazon AWS)');
    expect(screen.getByTestId('signup-network-country').textContent).toBe('US');
    expect(screen.getByTestId('signup-network-datacenter-chip')).toBeTruthy();
  });

  it('shows unknowns without a datacenter flag when no network data reached the origin', () => {
    renderMeta({ ip: null, asn: null, asnOrg: null, country: null, isDatacenter: null });

    expect(screen.getByTestId('signup-network-ip').textContent).toBe('Unknown');
    expect(screen.getByTestId('signup-network-asn').textContent).toBe('Unknown');
    expect(screen.queryByTestId('signup-network-datacenter-chip')).toBeNull();
  });
});
