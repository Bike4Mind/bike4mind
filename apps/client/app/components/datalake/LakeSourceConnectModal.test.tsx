import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  panelProps: [] as { lake: unknown; onChatStarted?: unknown }[],
}));

// The panel is a registry entry, so mock the GitHub one to read back the props the modal hands it.
vi.mock('@client/app/components/DataLakeWizard/steps/GitHubConnectAction', () => ({
  default: (props: { lake: unknown; onChatStarted?: unknown }) => {
    h.panelProps.push(props);
    return <div data-testid="github-connect-action" />;
  },
}));

import LakeSourceConnectModal from './LakeSourceConnectModal';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (ui: ReactNode) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);

const LAKE = { id: 'lake1', organizationId: 'org-1', canManage: true };

beforeEach(() => {
  h.panelProps.length = 0;
});

describe('LakeSourceConnectModal', () => {
  it('forwards a caller-supplied chat completion to the source panel', () => {
    const onChatStarted = vi.fn();
    wrap(<LakeSourceConnectModal lake={LAKE} kind="github" onClose={vi.fn()} onChatStarted={onChatStarted} />);

    expect(screen.getByTestId('github-connect-action')).toBeInTheDocument();
    expect(h.panelProps).toEqual([{ lake: LAKE, onChatStarted }]);
  });

  it('still renders the panel when the caller supplies no completion', () => {
    wrap(<LakeSourceConnectModal lake={LAKE} kind="github" onClose={vi.fn()} />);

    expect(screen.getByTestId('github-connect-action')).toBeInTheDocument();
    expect(h.panelProps).toEqual([{ lake: LAKE, onChatStarted: undefined }]);
  });
});
