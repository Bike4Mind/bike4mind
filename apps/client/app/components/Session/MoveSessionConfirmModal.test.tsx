import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { WORKSPACE_SURFACES, type WorkspaceSurface } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { NEUTRAL_WORKSPACE_LABEL } from '@client/app/utils/workspaceLabels';

import MoveSessionConfirmModal from './MoveSessionConfirmModal';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const main = WORKSPACE_SURFACES.find(surface => surface.id === null);
const gated = WORKSPACE_SURFACES.find(surface => surface.id !== null);
if (!main || !gated) throw new Error('expected the main list and a workspace');

function renderModal(from: WorkspaceSurface | undefined) {
  render(
    <TestWrapper>
      <MoveSessionConfirmModal
        open
        sessionName="Plan"
        from={from}
        to={main ?? null}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    </TestWrapper>
  );
  return screen.getByTestId('move-session-modal').textContent ?? '';
}

describe('MoveSessionConfirmModal source label', () => {
  it('names the source by the label it is presented with', () => {
    const text = renderModal({ ...gated, label: 'Partner Desk' });

    expect(text).toContain(`will move from Partner Desk to ${main.label}`);
    expect(text).not.toContain(gated.label);
  });

  it('reads the neutral label in lower case mid-sentence', () => {
    const text = renderModal({ ...gated, label: NEUTRAL_WORKSPACE_LABEL });

    expect(text).toContain(`will move from this workspace to ${main.label}`);
    expect(text).toContain("It will leave this workspace's notebook list");
    expect(text).not.toContain(gated.label);
  });

  it('falls back to neutral wording with no source workspace', () => {
    expect(renderModal(undefined)).toContain('will move from this workspace');
  });
});
