// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { skillTemplateFreeRunInputKey } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { NEW_NOTEBOOK_DRAFT_KEY, useChatInput } from '@client/app/hooks/useChatInput';

const h = vi.hoisted(() => ({ post: vi.fn(), navigate: vi.fn() }));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => h.navigate,
  useParams: () => ({ slug: 'article-bullets' }),
}));
vi.mock('@client/app/hooks/useDocumentTitle', () => ({ useDocumentTitle: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: h.post } }));

import SkillTemplateTryPage from './$slug';

const appTheme = extendTheme({ ...getThemeConfig() });
const KEY = skillTemplateFreeRunInputKey('article-bullets');

function renderPage() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CssVarsProvider theme={appTheme}>
        <SkillTemplateTryPage />
      </CssVarsProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe('SkillTemplateTryPage', () => {
  it('opens a new chat prefilled with the skill and the example prompt', async () => {
    h.post.mockResolvedValue({
      data: { skillName: 'article-bullets', examplePrompt: 'Turn this into bullets', imported: true },
    });
    renderPage();

    expect(screen.getByTestId('skill-template-try-loading')).toBeTruthy();
    await waitFor(() =>
      expect(h.navigate).toHaveBeenCalledWith({
        to: '/new',
        search: { goal: '/article-bullets Turn this into bullets' },
        replace: true,
      })
    );
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.post).toHaveBeenCalledWith('/api/skills/template/try/article-bullets');
  });

  it('clears a saved new-chat draft so it cannot replace the prefilled prompt', async () => {
    useChatInput.getState().setDraft(NEW_NOTEBOOK_DRAFT_KEY, '/article-bullets an older prompt');
    h.post.mockResolvedValue({
      data: { skillName: 'article-bullets-2', examplePrompt: 'Turn this into bullets', imported: true },
    });
    renderPage();

    await waitFor(() => expect(h.navigate).toHaveBeenCalled());
    expect(useChatInput.getState().getDraft(NEW_NOTEBOOK_DRAFT_KEY)).toBe('');
  });

  it("prefers the visitor's free-run text and clears it once used", async () => {
    window.localStorage.setItem(KEY, '  My pasted article  ');
    h.post.mockResolvedValue({
      data: { skillName: 'article-bullets-2', examplePrompt: 'Turn this into bullets', imported: true },
    });
    renderPage();

    await waitFor(() =>
      expect(h.navigate).toHaveBeenCalledWith(
        expect.objectContaining({ search: { goal: '/article-bullets-2 My pasted article' } })
      )
    );
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('shows the error and keeps the free-run text when the skill cannot be opened', async () => {
    window.localStorage.setItem(KEY, 'My pasted article');
    h.post.mockRejectedValue(new Error('Template not found'));
    renderPage();

    expect((await screen.findByTestId('skill-template-try-error')).textContent).toContain('Template not found');
    expect(screen.getByTestId('skill-template-try-market-btn')).toBeTruthy();
    expect(h.navigate).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(KEY)).toBe('My pasted article');
  });
});
