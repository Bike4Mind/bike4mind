import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

/**
 * POST /api/artifacts answers with an { artifact, ... } envelope, and the creator owns the single
 * success toast for the create it performed. Pins both: one toast naming the artifact, and onSave
 * receiving the unwrapped artifact rather than the envelope.
 */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: mocks.apiGet, post: mocks.apiPost, delete: vi.fn() },
}));
vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { ArtifactCreator } from './ArtifactCreator';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const TYPES_RESPONSE = {
  types: [{ type: 'html', name: 'HTML', description: 'HTML page', category: 'web' }],
  categories: ['web'],
};

const CREATED = { id: 'artifact_1', type: 'html', title: 'My Artifact', status: 'draft' };

/** Fills the form and saves; returns the onSave spy. */
async function createArtifact() {
  const onSave = vi.fn();
  mocks.apiGet.mockResolvedValue({ data: TYPES_RESPONSE });
  mocks.apiPost.mockResolvedValue({ data: { artifact: CREATED, content: {}, version: {} } });
  const user = userEvent.setup();
  render(
    <TestWrapper>
      {/* defaultContent satisfies the content-required validation without touching the editor tab. */}
      <ArtifactCreator defaultType="html" defaultContent="<h1>hi</h1>" onSave={onSave} />
    </TestWrapper>
  );

  await user.type(await screen.findByTestId('artifact-creator-title-input'), 'My Artifact');
  await user.click(await screen.findByTestId('artifact-creator-save-btn'));
  return onSave;
}

describe('ArtifactCreator - create success notification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('raises exactly one success toast, naming the created artifact', async () => {
    await createArtifact();

    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith('Artifact "My Artifact" created successfully!')
    );
    // Count asserted after the await: a bare count check would pass before the toast fires.
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('hands onSave the unwrapped artifact, not the response envelope', async () => {
    const onSave = await createArtifact();

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(CREATED);
  });
});
