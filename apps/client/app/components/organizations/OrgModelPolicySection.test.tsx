import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import {
  ModelBackend,
  type IOrganizationDocument,
  type OrgModelPolicy,
  type StoredOrgModelPolicy,
} from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    view: undefined as { policy: StoredOrgModelPolicy; invalidStored: boolean } | undefined,
    save: vi.fn(),
    reset: vi.fn(),
    choicesOrgId: undefined as string | undefined,
  },
}));

vi.mock('@client/app/hooks/data/useOrgModelPolicy', () => ({
  useOrgModelPolicy: () => ({ data: mocks.view, isLoading: false, isError: false }),
  useSaveOrgModelPolicy: () => ({ mutate: mocks.save, isPending: false }),
  useResetOrgModelPolicy: () => ({ mutate: mocks.reset, isPending: false }),
}));
vi.mock('@client/app/hooks/data/useModelInfo', () => ({
  useOrgModelChoices: (orgId: string) => {
    mocks.choicesOrgId = orgId;
    return { data: [{ id: 'gpt', name: 'GPT', backend: ModelBackend.OpenAI }] };
  },
}));

import OrgModelPolicySection from './OrgModelPolicySection';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const UNRESTRICTED: OrgModelPolicy = { allowedProviders: null, allowedModels: null, allowedTools: null };
const organization = { id: 'org-1' } as unknown as IOrganizationDocument;

const renderSection = () => render(<OrgModelPolicySection organization={organization} />, { wrapper: TestWrapper });
const toggleSwitch = (id: string) =>
  fireEvent.click(screen.getByTestId(`org-model-policy-${id}-switch`).querySelector('input') as HTMLInputElement);
const tick = (testId: string) => fireEvent.click(screen.getByTestId(testId).querySelector('input') as HTMLInputElement);
const saveButton = () => screen.getByTestId('org-model-policy-save-btn') as HTMLButtonElement;

describe('OrgModelPolicySection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.view = { policy: UNRESTRICTED, invalidStored: false };
  });

  it('renders the unrestricted default with nothing to save', () => {
    renderSection();

    expect(screen.queryByTestId(`org-model-policy-provider-${ModelBackend.OpenAI}`)).toBeNull();
    expect(screen.queryByTestId('org-model-policy-invalid-alert')).toBeNull();
    expect(saveButton().disabled).toBe(true);
  });

  it('keeps save disabled while a restricted provider list is empty', () => {
    renderSection();
    toggleSwitch('providers');

    expect(saveButton().disabled).toBe(true);
    tick(`org-model-policy-provider-${ModelBackend.OpenAI}`);
    expect(saveButton().disabled).toBe(false);
  });

  it('saves the chosen providers and tools, leaving models unrestricted', () => {
    renderSection();
    toggleSwitch('providers');
    tick(`org-model-policy-provider-${ModelBackend.Anthropic}`);
    toggleSwitch('tools');
    tick('org-model-policy-tool-web_search');
    fireEvent.click(saveButton());

    expect(mocks.save).toHaveBeenCalledWith({
      allowedProviders: [ModelBackend.Anthropic],
      allowedModels: null,
      allowedTools: ['web_search'],
    });
  });

  it('allows saving no built-in tools at all', () => {
    renderSection();
    toggleSwitch('tools');
    fireEvent.click(saveButton());

    expect(mocks.save).toHaveBeenCalledWith({ ...UNRESTRICTED, allowedTools: [] });
  });

  it('loads a stored restriction and resets it through DELETE', () => {
    mocks.view = { policy: { ...UNRESTRICTED, allowedProviders: [ModelBackend.OpenAI] }, invalidStored: false };
    renderSection();

    const box = screen.getByTestId(`org-model-policy-provider-${ModelBackend.OpenAI}`).querySelector('input');
    expect((box as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByTestId('org-model-policy-reset-btn'));
    expect(mocks.reset).toHaveBeenCalledTimes(1);
  });

  it('disables reset when nothing is stored, unless the stored policy is unreadable', () => {
    renderSection();
    const resetButton = () => screen.getByTestId('org-model-policy-reset-btn') as HTMLButtonElement;
    expect(resetButton().disabled).toBe(true);
  });

  it('offers models from the org being edited and keeps a stored id the catalog no longer lists', () => {
    mocks.view = { policy: { ...UNRESTRICTED, allowedModels: ['gpt', 'retired-model'] }, invalidStored: false };
    renderSection();

    expect(mocks.choicesOrgId).toBe('org-1');
    expect(screen.getByTestId('org-model-policy-models-select').textContent).toContain('retired-model');
  });

  it('warns about an unreadable stored policy and lets it be saved over', () => {
    mocks.view = { policy: UNRESTRICTED, invalidStored: true };
    renderSection();

    expect(screen.getByTestId('org-model-policy-invalid-alert')).toBeTruthy();
    expect(saveButton().disabled).toBe(false);
    expect((screen.getByTestId('org-model-policy-reset-btn') as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps a selected known model visible after its provider is excluded from the draft', () => {
    mocks.view = {
      policy: { ...UNRESTRICTED, allowedProviders: [ModelBackend.OpenAI], allowedModels: ['gpt'] },
      invalidStored: false,
    };
    renderSection();
    tick(`org-model-policy-provider-${ModelBackend.OpenAI}`);
    tick(`org-model-policy-provider-${ModelBackend.Anthropic}`);
    expect(screen.getByTestId('org-model-policy-models-select').textContent).toContain(
      'GPT (outside selected providers)'
    );
    expect(screen.getByText(/A retired model ID also allows its configured successor/)).toBeTruthy();
  });

  it('shows obsolete selections and requires their explicit removal before a strict save', () => {
    mocks.view = {
      policy: {
        ...UNRESTRICTED,
        allowedProviders: [ModelBackend.OpenAI, 'retired-provider'],
        allowedTools: ['web_search', 'removed_tool'],
      },
      invalidStored: false,
    };
    renderSection();
    expect(screen.getByLabelText('retired-provider (unrecognized; remove to save)')).toBeTruthy();
    expect(screen.getByLabelText('removed_tool (unrecognized; remove to save)')).toBeTruthy();
    tick('org-model-policy-provider-retired-provider');
    expect(saveButton().disabled).toBe(true);
    tick('org-model-policy-tool-removed_tool');
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    expect(mocks.save).toHaveBeenCalledWith({
      allowedProviders: [ModelBackend.OpenAI],
      allowedModels: null,
      allowedTools: ['web_search'],
    });
  });
});
