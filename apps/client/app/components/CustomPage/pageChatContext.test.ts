import { afterEach, describe, expect, it } from 'vitest';
import type { ICustomPageDocument } from '@bike4mind/common';
import { getSurfaceChatContext } from '@client/app/utils/surfaceChatContext';
import {
  PAGE_CONTEXT_STATE_MAX_CHARS,
  clearActiveCustomPage,
  getPageChatContext,
  setActiveCustomPage,
} from './pageChatContext';

const makePage = (state: Record<string, unknown> = { ingredients: ['eggs', 'rice'] }): ICustomPageDocument => ({
  id: 'a'.repeat(24),
  userId: 'u1',
  name: 'Daily menu',
  state,
  widgets: [{ id: 'cookable', type: 'card-list', title: 'What I can cook', items: [] }],
  orchestratorSessionId: 's1',
  version: 0,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

const goTo = (path: string) => window.history.pushState({}, '', path);

afterEach(() => {
  clearActiveCustomPage();
  goTo('/');
});

describe('page chat context', () => {
  it('returns nothing when no page is active', () => {
    goTo('/pages/x');
    expect(getPageChatContext()).toEqual({});
  });

  it('returns nothing off the page route or when another session is current', () => {
    setActiveCustomPage(makePage(), 's1');
    goTo('/notebooks/s1');
    expect(getPageChatContext()).toEqual({});
    goTo('/pages/x');
    setActiveCustomPage(makePage(), 'other-session');
    expect(getPageChatContext()).toEqual({});
  });

  it('returns only briefContext with the page name, state and widgets while active', () => {
    goTo('/pages/x');
    setActiveCustomPage(makePage(), 's1');
    const ctx = getPageChatContext();
    expect(Object.keys(ctx)).toEqual(['briefContext']);
    expect(ctx.briefContext).toContain('Daily menu');
    expect(ctx.briefContext).toContain('"ingredients":["eggs","rice"]');
    expect(ctx.briefContext).toContain('cookable (card-list): What I can cook');
    expect(ctx.briefContext).toContain('page_update_state');
    expect(getSurfaceChatContext().briefContext).toBe(ctx.briefContext);
  });

  it('truncates a large state', () => {
    goTo('/pages/x');
    setActiveCustomPage(makePage({ notes: 'x'.repeat(PAGE_CONTEXT_STATE_MAX_CHARS * 2) }), 's1');
    const brief = getPageChatContext().briefContext ?? '';
    expect(brief).toContain('truncated');
    expect(brief.length).toBeLessThan(PAGE_CONTEXT_STATE_MAX_CHARS + 600);
  });
});
