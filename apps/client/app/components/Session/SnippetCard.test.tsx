import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { SnippetMeta } from '@bike4mind/common';

const createFabFileOnServerWithUpload = vi.fn();
vi.mock('@client/app/utils/filesAPICalls', () => ({
  createFabFileOnServerWithUpload: (...args: unknown[]) => createFabFileOnServerWithUpload(...args),
}));

vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSession: null, setCurrentSession: vi.fn(), currentSessionId: 's1' }),
  useWorkBenchFiles: () => [],
  useWorkBenchActions: () => ({ setWorkBenchFiles: vi.fn() }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { SnippetCard } from './SnippetCard';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

function meta(overrides: Partial<SnippetMeta> = {}): SnippetMeta {
  return { version: 1, id: 'snip-1', title: 'My Snippet', type: 'python', lineCount: 2, previewLines: 2, ...overrides };
}

describe('SnippetCard save-as-file', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createFabFileOnServerWithUpload.mockResolvedValue({ id: 'fab-1' });
  });

  // Regression: this used to build its own filename with `title.toLowerCase().replace(/\s+/g,
  // '_')` + `.${meta.type}` and a five-language-only mime ternary - the same bugs
  // artifactFileName/getCodeFileType fixed elsewhere (non-ASCII titles wiped to nothing, and
  // most languages sent out as text/plain). Routing through the shared helpers fixes both here.
  it('saves via the shared getCodeFileType extension/MIME instead of the raw language tag', async () => {
    const user = userEvent.setup();
    render(
      <TestWrapper>
        <SnippetCard meta={meta({ type: 'python' })} content="print(1)" expanded isEditMode={false} />
      </TestWrapper>
    );

    await user.click(screen.getByRole('button', { name: /save/i }));

    expect(createFabFileOnServerWithUpload).toHaveBeenCalledTimes(1);
    const [data, file] = createFabFileOnServerWithUpload.mock.calls[0];
    expect(data.fileName).toMatch(/^my_snippet_\d+\.py$/);
    expect(data.mimeType).toBe('text/x-python');
    expect(file.name).toBe(data.fileName);
  });

  it('sanitizes a title with path/OS-reserved characters via artifactFileName', async () => {
    const user = userEvent.setup();
    render(
      <TestWrapper>
        <SnippetCard meta={meta({ title: 'a/b:c', type: 'go' })} content="package main" expanded isEditMode={false} />
      </TestWrapper>
    );

    await user.click(screen.getByRole('button', { name: /save/i }));

    const [data] = createFabFileOnServerWithUpload.mock.calls[0];
    expect(data.fileName).toMatch(/^a_b_c_\d+\.go$/);
    expect(data.mimeType).toBe('text/x-go');
  });
});
