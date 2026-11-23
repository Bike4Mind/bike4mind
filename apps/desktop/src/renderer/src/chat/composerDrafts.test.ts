import { describe, expect, it, vi } from 'vitest';
import type { ComposerDrafts } from '@shared/composerDrafts';
import { createComposerDraftsStore } from './composerDrafts';

function bridge(saved: ComposerDrafts = {}) {
  return {
    list: vi.fn(async () => saved),
    save: vi.fn(async (_sessionId: string, _text: string) => undefined),
  };
}

describe('createComposerDraftsStore', () => {
  it('restores saved drafts on hydrate', async () => {
    const api = bridge({ s1: 'from last launch' });
    const drafts = createComposerDraftsStore(() => api);
    await drafts.hydrate();
    expect(drafts.state.getState()).toEqual({ drafts: { s1: 'from last launch' }, hydrated: true });
  });

  it('keeps text typed before hydrate over the saved copy', async () => {
    const api = bridge({ s1: 'old', s2: 'cleared since' });
    const drafts = createComposerDraftsStore(() => api);
    drafts.update('s1', 'new');
    drafts.update('s2', 'x');
    drafts.update('s2', '');
    await drafts.hydrate();
    expect(drafts.state.getState().drafts).toEqual({ s1: 'new' });
  });

  it('sends every change to main at once, with no delay a quit could cut short', () => {
    const api = bridge();
    const drafts = createComposerDraftsStore(() => api);
    drafts.update('s1', 'h');
    drafts.update('s1', 'he');
    drafts.update('s2', 'two');
    expect(api.save.mock.calls).toEqual([
      ['s1', 'h'],
      ['s1', 'he'],
      ['s2', 'two'],
    ]);
  });

  it('clears when the composer is emptied or sent', () => {
    const api = bridge();
    const drafts = createComposerDraftsStore(() => api);
    drafts.update('s1', 'about to send');
    drafts.update('s1', '');
    expect(api.save.mock.calls).toEqual([
      ['s1', 'about to send'],
      ['s1', ''],
    ]);
    expect(drafts.state.getState().drafts).toEqual({});
  });

  it('treats blank text as no draft and does not save an unchanged one', () => {
    const api = bridge();
    const drafts = createComposerDraftsStore(() => api);
    drafts.update('s1', '   ');
    drafts.update('s1', '');
    expect(api.save).not.toHaveBeenCalled();
    expect(drafts.state.getState().drafts).toEqual({});
  });

  it('keeps drafts in memory when there is no bridge', async () => {
    const drafts = createComposerDraftsStore(() => undefined);
    drafts.update('s1', 'only here');
    await drafts.hydrate();
    expect(drafts.state.getState()).toEqual({ drafts: { s1: 'only here' }, hydrated: true });
  });

  it('keeps the text of a conversation that does not exist yet in memory without sending it to main', () => {
    const api = bridge();
    const drafts = createComposerDraftsStore(() => api);
    drafts.update('draft-123', 'not a session yet');
    expect(drafts.state.getState().drafts).toEqual({ 'draft-123': 'not a session yet' });
    expect(api.save).not.toHaveBeenCalled();
  });
});
