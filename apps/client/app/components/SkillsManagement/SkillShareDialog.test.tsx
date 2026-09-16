import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { ISkillWithSharing } from '@client/app/hooks/data/skills';
import SkillShareDialog from './SkillShareDialog';

const h = vi.hoisted(() => ({ mutateAsync: vi.fn(), lookupUserByEmail: vi.fn() }));

vi.mock('@client/app/hooks/data/skills', () => ({
  useUpdateSkillSharing: () => ({ mutateAsync: h.mutateAsync, isPending: false }),
  lookupUserByEmail: h.lookupUserByEmail,
}));

const appTheme = extendTheme({ ...getThemeConfig() });

const skill = { id: 'skill-1', name: 'Summarize', users: [], isGlobalRead: false, isGlobalWrite: false };

const renderDialog = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <SkillShareDialog onClose={vi.fn()} skill={skill as unknown as ISkillWithSharing} />
    </CssVarsProvider>
  );

describe('SkillShareDialog', () => {
  beforeEach(() => vi.clearAllMocks());

  // The live global-share surface. isGlobalRead/isGlobalWrite publish a skill to the whole
  // instance, so the server gates them on the SHARE predicate rather than update - which means an
  // update-without-share holder gets a legitimate 403 here, and needs to be told which it was.
  // axios resolves isAxiosError by property, not prototype, so the flag alone is a faithful reject.
  it('shows the servers reason when a global-share save is refused', async () => {
    h.mutateAsync.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 403'), {
        isAxiosError: true,
        response: { status: 403, data: { error: 'Only a share holder can publish globally' } },
      })
    );

    renderDialog();
    fireEvent.click(screen.getByTestId('skill-share-save-btn'));

    await waitFor(() =>
      expect(screen.getByTestId('skill-share-error')).toHaveTextContent('Only a share holder can publish globally')
    );
  });

  it('does not fall back to the fixed string when the envelope carries a reason', async () => {
    h.mutateAsync.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 403'), {
        isAxiosError: true,
        response: { status: 403, data: { error: 'Only a share holder can publish globally' } },
      })
    );

    renderDialog();
    fireEvent.click(screen.getByTestId('skill-share-save-btn'));

    await waitFor(() => expect(screen.getByTestId('skill-share-error')).toBeInTheDocument());
    expect(screen.getByTestId('skill-share-error')).not.toHaveTextContent('Failed to save sharing changes');
  });
});
