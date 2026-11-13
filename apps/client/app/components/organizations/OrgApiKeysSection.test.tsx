import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { ApiKeyScope, ApiKeyStatus, type IOrgApiKeyView } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

const rotateCallbackSecret = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  reset: vi.fn(),
  isPending: false,
}));
const idle = vi.hoisted(() => ({ mutateAsync: vi.fn(), reset: vi.fn(), isPending: false }));
const key: IOrgApiKeyView = {
  id: 'key1',
  name: 'Webhook service',
  keyPrefix: 'b4m_live_abc',
  scopes: [ApiKeyScope.AI_GENERATE],
  status: ApiKeyStatus.ACTIVE,
  createdAt: new Date('2026-01-01'),
} as IOrgApiKeyView;

vi.mock('@client/app/hooks/data/orgApiKeys', () => ({
  useOrgApiKeys: () => ({ data: [key], isLoading: false, isError: false }),
  useCreateOrgApiKey: () => idle,
  useRotateOrgApiKey: () => idle,
  useRevokeOrgApiKey: () => idle,
  useRotateOrgApiKeyCallbackSecret: () => rotateCallbackSecret,
}));

import OrgApiKeysSection from './OrgApiKeysSection';

const appTheme = extendTheme({ ...getThemeConfig() });

describe('OrgApiKeysSection callback signing secret', () => {
  it('confirms, then shows the new secret once in the secret dialog', async () => {
    rotateCallbackSecret.mutateAsync.mockResolvedValue({
      id: 'key1',
      name: 'Webhook service',
      callbackSigningSecret: 'whsec_test',
      callbackSigningSecretCreatedAt: '2026-01-02T00:00:00.000Z',
    });
    render(
      <CssVarsProvider theme={appTheme}>
        <OrgApiKeysSection organizationId="org1" />
      </CssVarsProvider>
    );

    fireEvent.click(screen.getByTestId('org-api-key-callback-secret-btn-key1'));
    fireEvent.click(await screen.findByRole('button', { name: 'Create secret' }));

    await waitFor(() => expect(screen.getByTestId('org-api-key-secret-value')).toHaveValue('whsec_test'));
    expect(rotateCallbackSecret.mutateAsync).toHaveBeenCalledWith('key1');
    expect(screen.getByText('Copy your callback signing secret')).toBeInTheDocument();
  });
});
