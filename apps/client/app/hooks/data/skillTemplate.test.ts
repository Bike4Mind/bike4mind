import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: h.get } }));

import type { SkillTemplateEditorView } from '@bike4mind/common';
import { nextSkillTemplatePoll, skillTemplatePollMs, waitForGeneratedImage } from './skillTemplate';

const quest = (data: Record<string, unknown>) => ({ data });

beforeEach(() => {
  h.get.mockReset();
});

describe('waitForGeneratedImage', () => {
  it('polls the quest until it has an image', async () => {
    h.get.mockResolvedValueOnce(quest({ images: [] })).mockResolvedValueOnce(quest({ images: ['a.png'] }));
    await expect(waitForGeneratedImage('q1', { intervalMs: 0 })).resolves.toBeUndefined();
    expect(h.get).toHaveBeenCalledTimes(2);
    expect(h.get).toHaveBeenCalledWith('/api/quests/q1');
  });

  it('fails when the generation errors', async () => {
    h.get.mockResolvedValue(quest({ images: [], type: 'error' }));
    await expect(waitForGeneratedImage('q1', { intervalMs: 0 })).rejects.toThrow('The image generation failed');
  });

  it('keeps polling through a transient request failure', async () => {
    h.get.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(quest({ images: ['a.png'] }));
    await expect(waitForGeneratedImage('q1', { intervalMs: 0 })).resolves.toBeUndefined();
    expect(h.get).toHaveBeenCalledTimes(2);
  });

  it('rethrows after three consecutive request failures', async () => {
    h.get.mockRejectedValue(new Error('network down'));
    await expect(waitForGeneratedImage('q1', { intervalMs: 0 })).rejects.toThrow('network down');
    expect(h.get).toHaveBeenCalledTimes(3);
  });

  it('gives up after the poll budget', async () => {
    h.get.mockResolvedValue(quest({ images: [] }));
    await expect(waitForGeneratedImage('q1', { intervalMs: 0, maxPolls: 3 })).rejects.toThrow('taking too long');
    expect(h.get).toHaveBeenCalledTimes(3);
  });
});

describe('skillTemplatePollMs', () => {
  const withExample = (status: string) =>
    ({ template: { example: { status } }, previewImageStatus: null }) as unknown as SkillTemplateEditorView;

  it('polls while the example runs and stops once it is ready or failed', () => {
    expect(skillTemplatePollMs(withExample('running'), 1)).toBe(3000);
    expect(skillTemplatePollMs(withExample('ready'), 2)).toBe(false);
    expect(skillTemplatePollMs(withExample('failed'), 2)).toBe(false);
  });

  it('gives up on a run that never settles', () => {
    expect(skillTemplatePollMs(withExample('running'), 300)).toBe(false);
  });

  it('still polls a pending preview image', () => {
    const view = { template: null, previewImageStatus: 'pending' } as unknown as SkillTemplateEditorView;
    expect(skillTemplatePollMs(view, 1)).toBe(3000);
    expect(skillTemplatePollMs(undefined, 1)).toBe(false);
  });
});

describe('nextSkillTemplatePoll', () => {
  const running = (runAt: string) =>
    ({
      template: { example: { status: 'running', runAt } },
      previewImageStatus: null,
    }) as unknown as SkillTemplateEditorView;

  it('counts polls per run, so a second run in the same session is still polled', () => {
    let state = { key: '', polls: 0 };
    let last: number | false = false;
    for (let i = 0; i < 400; i += 1) {
      const next = nextSkillTemplatePoll(state, running('2026-01-01T00:00:00Z'));
      state = next.state;
      last = next.ms;
    }
    expect(last).toBe(false);

    expect(nextSkillTemplatePoll(state, running('2026-01-01T01:00:00Z')).ms).toBe(3000);
  });

  it('restarts the budget for a new image after a run used it up', () => {
    const pending = (fabFileId: string) =>
      ({
        template: { previewImage: { fabFileId } },
        previewImageStatus: 'pending',
      }) as unknown as SkillTemplateEditorView;
    let state = { key: '', polls: 0 };
    for (let i = 0; i < 150; i += 1) state = nextSkillTemplatePoll(state, pending('f1')).state;
    expect(nextSkillTemplatePoll(state, pending('f1')).ms).toBe(false);
    expect(nextSkillTemplatePoll(state, pending('f2')).ms).toBe(3000);
  });
});
