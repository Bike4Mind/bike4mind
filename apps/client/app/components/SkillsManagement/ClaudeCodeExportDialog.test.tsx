import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import ClaudeCodeExportDialog, { type ClaudeCodeExportDialogProps } from './ClaudeCodeExportDialog';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const createKey = vi.hoisted(() => ({
  mutate: vi.fn(),
  onSuccess: undefined as ((r: { key: string }) => void) | undefined,
}));
vi.mock('@client/app/hooks/data/userApiKeys', () => ({
  useCreateUserApiKey: ({ onSuccess }: { onSuccess: (r: { key: string }) => void }) => {
    createKey.onSuccess = onSuccess;
    return { mutate: createKey.mutate, isPending: false };
  },
}));
const publicConfig = vi.hoisted(() => ({
  data: { apiUrl: 'https://canonical.example.test' },
  isPending: false,
  refetch: vi.fn(),
}));
vi.mock('@client/app/hooks/data/settings', () => ({ usePublicConfig: () => publicConfig }));
vi.mock('@client/app/hooks/data/skillMarket', () => ({
  useSkillBundles: () => ({ data: { bundles: [], listings: [], canEdit: false }, isPending: false, isError: false }),
  useSaveSkillBundle: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteSkillBundle: () => ({ mutate: vi.fn(), isPending: false }),
}));
const downloadData = vi.hoisted(() => vi.fn());
vi.mock('@client/app/utils/download', () => ({ downloadData }));

const appTheme = extendTheme({ ...getThemeConfig() });

const skill = { name: 'review-pr', description: 'Review a PR', body: 'Review $ARGUMENTS.' };

const renderDialog = (props: Partial<ClaudeCodeExportDialogProps> = {}) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ClaudeCodeExportDialog onClose={vi.fn()} skill={skill} sourcePath="/skills/abc" thirdParty={false} {...props} />
    </CssVarsProvider>
  );

const writeText = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  publicConfig.data.apiUrl = 'https://canonical.example.test';
  publicConfig.isPending = false;
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

const ORG_ID = '65f0aabbccddeeff00112233';

describe('ClaudeCodeExportDialog', () => {
  it('copies an install command stamped with the source page and version', async () => {
    renderDialog({ sourcePath: '/skills/market/l1', version: 3 });
    fireEvent.click(screen.getByTestId('skill-claude-code-copy-cmd'));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const command: string = writeText.mock.calls[0][0];
    expect(command).toMatch(
      /^mkdir -p ~\/\.claude\/skills\/review-pr && cat > ~\/\.claude\/skills\/review-pr\/SKILL\.md <<'/
    );
    expect(command).toContain(`# Bike4Mind-Source: ${window.location.origin}/skills/market/l1\n# Version: 3\n`);
  });

  it('shows no warnings for a plain own skill', () => {
    renderDialog();
    expect(screen.queryByTestId('skill-claude-code-b4m-only')).not.toBeInTheDocument();
    expect(screen.queryByText(/third-party skill/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('skill-claude-code-import-hint')).not.toBeInTheDocument();
    expect(screen.queryByTestId('skill-claude-code-files-not-included')).not.toBeInTheDocument();
  });

  it('warns that supporting files are not exported', () => {
    renderDialog({ skill: { ...skill, files: [{ path: 'scripts/run.py', content: 'x' }] } });
    expect(screen.getByTestId('skill-claude-code-files-not-included')).toHaveTextContent('1 supporting file');
  });

  it('warns about Bike4Mind-only tools and agents, third-party text, and a missing import', () => {
    renderDialog({
      skill: { ...skill, body: 'Ask @github_manager, not me@example.com.', allowedTools: ['web_search'] },
      thirdParty: true,
      showImportHint: true,
    });
    const alert = screen.getByTestId('skill-claude-code-b4m-only');
    expect(alert).toHaveTextContent('web_search');
    expect(alert).toHaveTextContent('@github_manager');
    expect(alert).not.toHaveTextContent('example');
    expect(screen.getByText(/third-party skill/)).toBeInTheDocument();
    expect(screen.getByTestId('skill-claude-code-import-hint')).toBeInTheDocument();
  });

  it('reports a name Claude Code cannot use instead of a clipboard failure', () => {
    renderDialog({ skill: { ...skill, name: 'Bad Name' } });
    fireEvent.click(screen.getByTestId('skill-claude-code-copy-cmd'));
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('use Download'));
    expect(writeText).not.toHaveBeenCalled();
  });

  it('shows no tabs without an org marketplace', () => {
    renderDialog();
    expect(screen.queryByTestId('skill-claude-code-tab-marketplace')).not.toBeInTheDocument();
  });

  it('warns where the key is stored and never to commit it', () => {
    renderDialog({ marketplace: { org: { id: ORG_ID, name: 'Acme Labs' }, pluginName: 'foo-a1b2c3' } });
    fireEvent.click(screen.getByTestId('skill-claude-code-tab-marketplace'));
    expect(screen.getByText(/known_marketplaces\.json/)).toBeInTheDocument();
    const warning = screen.getByTestId('skill-claude-code-key-warning');
    expect(warning).toHaveTextContent("never to a project's .claude/settings.json");
    expect(warning).toHaveTextContent('headersHelper');
    // A member who can't edit and sees no bundles gets no bundles section.
    expect(screen.queryByTestId('skill-claude-code-bundles')).not.toBeInTheDocument();
  });

  it('builds the team marketplace settings and mints a skills:read key into them', async () => {
    renderDialog({ marketplace: { org: { id: ORG_ID, name: 'Acme Labs' }, pluginName: 'foo-a1b2c3' } });
    fireEvent.click(screen.getByTestId('skill-claude-code-tab-marketplace'));

    const settings = () => JSON.parse(screen.getByTestId('skill-claude-code-marketplace-settings').textContent ?? '');
    expect(settings().extraKnownMarketplaces['b4m-org-65f0aabbccddeeff00112233']).toEqual({
      source: {
        source: 'url',
        url: `https://canonical.example.test/api/v1/skills/market/claude-marketplace.json?orgId=${ORG_ID}`,
        headers: { Authorization: 'Bearer b4m_<your skills:read key>' },
      },
      autoUpdate: true,
    });
    expect(screen.getByTestId('skill-claude-code-marketplace-install')).toHaveTextContent(
      '/plugin install foo-a1b2c3@b4m-org-65f0aabbccddeeff00112233'
    );

    fireEvent.click(screen.getByTestId('skill-claude-code-create-key'));
    expect(createKey.mutate).toHaveBeenCalledWith(expect.objectContaining({ scopes: ['skills:read'] }));
    act(() => createKey.onSuccess?.({ key: 'b4m_live_abc' }));
    expect(settings().extraKnownMarketplaces['b4m-org-65f0aabbccddeeff00112233'].source.headers.Authorization).toBe(
      'Bearer b4m_live_abc'
    );

    fireEvent.click(screen.getByTestId('skill-claude-code-copy-settings'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Bearer b4m_live_abc')));
  });

  it('waits for the canonical address before offering marketplace settings or key creation', () => {
    publicConfig.isPending = true;
    renderDialog({ marketplace: { org: { id: ORG_ID, name: 'Acme Labs' } } });
    fireEvent.click(screen.getByTestId('skill-claude-code-tab-marketplace'));
    expect(screen.getByText('Loading marketplace settings...')).toBeInTheDocument();
    expect(screen.queryByTestId('skill-claude-code-create-key')).not.toBeInTheDocument();
  });

  it('offers retry when the canonical address cannot be loaded', () => {
    publicConfig.data.apiUrl = '';
    renderDialog({ marketplace: { org: { id: ORG_ID, name: 'Acme Labs' } } });
    fireEvent.click(screen.getByTestId('skill-claude-code-tab-marketplace'));
    expect(screen.getByText('Could not load the marketplace address.')).toBeInTheDocument();
    expect(screen.queryByTestId('skill-claude-code-create-key')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('skill-claude-code-marketplace-retry'));
    expect(publicConfig.refetch).toHaveBeenCalledTimes(1);
  });

  it('omits the install line when the listing has no stored plugin name', () => {
    renderDialog({ marketplace: { org: { id: ORG_ID, name: 'Acme Labs' } } });
    fireEvent.click(screen.getByTestId('skill-claude-code-tab-marketplace'));
    expect(screen.queryByTestId('skill-claude-code-marketplace-install')).not.toBeInTheDocument();
    expect(screen.getByText(/to browse every skill/)).toBeInTheDocument();
  });

  it('names the skill in the title only without the marketplace tab', () => {
    const { unmount } = renderDialog();
    expect(screen.getByTestId('skill-claude-code-title')).toHaveTextContent('Use /review-pr in Claude Code');
    unmount();
    renderDialog({ marketplace: { org: { id: ORG_ID, name: 'Acme Labs' }, pluginName: 'foo-a1b2c3' } });
    expect(screen.getByTestId('skill-claude-code-title')).toHaveTextContent(/^Use in Claude Code$/);
  });

  it('explains marketplace setup, the plugin invocation and manual updates', () => {
    renderDialog({
      marketplace: { org: { id: ORG_ID, name: 'Acme Labs' }, pluginName: 'hello-team-abc123', skillName: 'Hello Team' },
    });
    fireEvent.click(screen.getByTestId('skill-claude-code-tab-marketplace'));
    const setup = screen.getByTestId('skill-claude-code-marketplace-setup');
    expect(setup).toHaveTextContent('claude -p "hi"');
    expect(setup).toHaveTextContent('not found');
    expect(setup).toHaveTextContent('claude plugin marketplace add <url>');
    expect(screen.getByTestId('skill-claude-code-marketplace-install-shell')).toHaveTextContent(
      `claude plugin install hello-team-abc123@b4m-org-${ORG_ID}`
    );
    expect(screen.getByTestId('skill-claude-code-marketplace-invoke')).toHaveTextContent(
      /^\/hello-team-abc123:hello-team$/
    );
    const update = screen.getByTestId('skill-claude-code-marketplace-update');
    expect(update).toHaveTextContent(`claude plugin marketplace update b4m-org-${ORG_ID}`);
    expect(update).toHaveTextContent(`claude plugin update hello-team-abc123@b4m-org-${ORG_ID}`);
    expect(update).toHaveTextContent('/reload-plugins');
  });

  it('omits the invocation without a skill name', () => {
    renderDialog({ marketplace: { org: { id: ORG_ID, name: 'Acme Labs' }, pluginName: 'hello-team-abc123' } });
    fireEvent.click(screen.getByTestId('skill-claude-code-tab-marketplace'));
    expect(screen.queryByTestId('skill-claude-code-marketplace-invoke')).not.toBeInTheDocument();
  });

  it('omits the invocation without a stored plugin name', () => {
    renderDialog({ marketplace: { org: { id: ORG_ID, name: 'Acme Labs' }, skillName: 'Hello Team' } });
    fireEvent.click(screen.getByTestId('skill-claude-code-tab-marketplace'));
    expect(screen.queryByTestId('skill-claude-code-marketplace-invoke')).not.toBeInTheDocument();
    expect(screen.getByTestId('skill-claude-code-marketplace-update')).toHaveTextContent(
      `claude plugin update <plugin>@b4m-org-${ORG_ID}`
    );
  });

  it('downloads the stamped SKILL.md', () => {
    renderDialog({ sourcePath: '/skills/abc' });
    fireEvent.click(screen.getByTestId('skill-claude-code-download'));
    expect(downloadData).toHaveBeenCalledTimes(1);
    const [content, filename, type] = downloadData.mock.calls[0];
    expect(content).toContain(`# Bike4Mind-Source: ${window.location.origin}/skills/abc`);
    expect(content).toContain('Review $ARGUMENTS.');
    expect(filename).toBe('SKILL.md');
    expect(type).toBe('text/markdown');
  });

  it('tells the user to download when the clipboard rejects', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    renderDialog();
    fireEvent.click(screen.getByTestId('skill-claude-code-copy-cmd'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/Could not copy/)));
    expect(toast.success).not.toHaveBeenCalled();
  });
});
