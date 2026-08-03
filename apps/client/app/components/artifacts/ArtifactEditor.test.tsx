import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

/**
 * PUT /api/artifacts/:id answers with an { artifact, ... } envelope, and the editor owns the single
 * success toast for the update it performed. Pins both: one toast naming the artifact, and onSave
 * receiving the unwrapped artifact rather than the envelope.
 */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPut: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: mocks.apiGet, put: mocks.apiPut, post: vi.fn(), delete: vi.fn() },
}));
vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));
vi.mock('@client/app/components/help', () => ({
  ContextHelpButton: () => null,
}));

import { ArtifactEditor } from './ArtifactEditor';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const TYPES_RESPONSE = {
  types: [{ type: 'html', name: 'HTML', description: 'HTML page', category: 'web' }],
  categories: ['web'],
};

const EXISTING = {
  id: 'artifact_1',
  type: 'html' as const,
  title: 'Original Title',
  content: '<h1>hi</h1>',
  contentSize: 11,
  contentHash: 'hash',
  status: 'draft' as const,
  visibility: 'private' as const,
  tags: [],
  version: 1,
  // Present so they don't register as changes: the editor defaults these when absent, which would
  // otherwise make them differ from originalData and land in the PUT body.
  permissions: { canRead: [], canWrite: [], canDelete: [], isPublic: false, inheritFromProject: true },
  metadata: {},
};

// Server-returned title differs from the typed text so the assertions pin the response value.
const TYPED_TITLE = 'Typed Rename';
const UPDATED = { ...EXISTING, title: 'Server Renamed' };

/** Renames the artifact and saves; returns the onSave spy. */
async function renameAndSave() {
  const onSave = vi.fn();
  mocks.apiGet.mockResolvedValue({ data: TYPES_RESPONSE });
  mocks.apiPut.mockResolvedValue({ data: { artifact: UPDATED, content: {}, version: {} } });
  const user = userEvent.setup();
  render(
    <TestWrapper>
      <ArtifactEditor artifact={EXISTING as never} onSave={onSave} />
    </TestWrapper>
  );

  // Save stays disabled until hasChanges flips, so the title must actually change.
  const title = await screen.findByTestId('artifact-editor-title-input');
  await user.clear(title);
  await user.type(title, TYPED_TITLE);
  await user.click(await screen.findByTestId('artifact-editor-save-btn'));
  return onSave;
}

describe('ArtifactEditor - update success notification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('raises exactly one success toast, naming the updated artifact', async () => {
    await renameAndSave();

    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith('Artifact "Server Renamed" updated successfully!')
    );
    // Count asserted after the await: a bare count check would pass before the toast fires.
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('PUTs only the changed fields, to the id of the artifact it was mounted with', async () => {
    await renameAndSave();

    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalledTimes(1));
    expect(mocks.apiPut).toHaveBeenCalledWith(`/api/artifacts/${EXISTING.id}`, { title: TYPED_TITLE });
  });

  it('hands onSave the unwrapped artifact, not the response envelope', async () => {
    const onSave = await renameAndSave();

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(UPDATED);
  });
});
