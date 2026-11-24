import { describe, it, expect, vi } from 'vitest';
import { DIRECTOR_TOOLS, buildDirectorSystemContext, defaultStudioTimeline, NotFoundError } from '@bike4mind/common';
import {
  DIRECTED_NO_TOOL_CHECK,
  directedFinalCheck,
  loadDirectorBriefing,
  withDirectedSessionTools,
  withDirectedSystemContext,
} from './agentExecutor.directedSession';

const compositionId = '64b7f0c2a1b2c3d4e5f60718';

describe('withDirectedSessionTools', () => {
  it('adds every director tool once to a directed session', () => {
    expect(
      withDirectedSessionTools(['web_search', 'production_storyboard'], { productionCompositionId: compositionId })
    ).toEqual(['web_search', ...DIRECTOR_TOOLS]);
  });

  it('leaves an undirected session unchanged', () => {
    const tools = ['web_search'];
    expect(withDirectedSessionTools(tools, {})).toBe(tools);
  });

  it('never adds them to an API-key run', () => {
    expect(withDirectedSessionTools([], { productionCompositionId: compositionId, apiKeyId: 'k1' })).toEqual([]);
  });
});

describe('withDirectedSystemContext', () => {
  const director = buildDirectorSystemContext(compositionId);

  it('injects the director context on a follow-up turn that carries none', () => {
    expect(
      withDirectedSystemContext(undefined, { productionCompositionId: compositionId, productionToolsReady: true })
    ).toBe(director);
  });

  it('does not repeat it when the Direct launch already sent the same context', () => {
    expect(
      withDirectedSystemContext(director, { productionCompositionId: compositionId, productionToolsReady: true })
    ).toBe(director);
  });

  it('puts the director context ahead of a different launch context', () => {
    expect(
      withDirectedSystemContext('Other context.', {
        productionCompositionId: compositionId,
        productionToolsReady: true,
      })
    ).toBe(`${director}\n\nOther context.`);
  });

  it('adds nothing when the production tools were not built', () => {
    expect(
      withDirectedSystemContext('Other context.', {
        productionCompositionId: compositionId,
        productionToolsReady: false,
      })
    ).toBe('Other context.');
  });

  it('adds nothing for an undirected session or an API-key run', () => {
    expect(withDirectedSystemContext(undefined, { productionToolsReady: true })).toBeUndefined();
    expect(
      withDirectedSystemContext(undefined, {
        productionCompositionId: compositionId,
        apiKeyId: 'k1',
        productionToolsReady: true,
      })
    ).toBeUndefined();
  });
});

describe('withDirectedSystemContext for a short film', () => {
  it('injects the film director context when the production is a short film', () => {
    const briefing = { template: 'short_film' as const, tone: 'tense', durationMs: 30_000 };
    const context = withDirectedSystemContext(undefined, {
      productionCompositionId: compositionId,
      productionToolsReady: true,
      briefing,
    });
    expect(context).toBe(buildDirectorSystemContext(compositionId, briefing));
    expect(context).toContain('a short film of about 30 seconds');
    expect(context).not.toBe(buildDirectorSystemContext(compositionId));
  });

  it("replaces a launch context built from a stale view with the production's own, never stacking both", () => {
    const briefing = { template: 'short_film' as const, tone: 'tense', durationMs: 30_000 };
    const stale = buildDirectorSystemContext(compositionId, { ...briefing, tone: 'wistful' });
    for (const launch of [stale, buildDirectorSystemContext(compositionId)]) {
      expect(
        withDirectedSystemContext(launch, {
          productionCompositionId: compositionId,
          productionToolsReady: true,
          briefing,
        })
      ).toBe(buildDirectorSystemContext(compositionId, briefing));
    }
  });

  it("keeps the launch's film context when the production could not be read", () => {
    const film = buildDirectorSystemContext(compositionId, { template: 'short_film', tone: 'wistful' });
    expect(
      withDirectedSystemContext(`${film}\n`, { productionCompositionId: compositionId, productionToolsReady: true })
    ).toBe(film);
  });

  it("still adds a launch context that is another production's director context", () => {
    const other = buildDirectorSystemContext('74b7f0c2a1b2c3d4e5f60718');
    expect(
      withDirectedSystemContext(other, { productionCompositionId: compositionId, productionToolsReady: true })
    ).toBe(`${buildDirectorSystemContext(compositionId)}\n\n${other}`);
  });
});

describe('loadDirectorBriefing', () => {
  const logger = () => ({ warn: vi.fn() });
  const film = {
    template: 'short_film' as const,
    brief: { tone: 'wistful' },
    timeline: defaultStudioTimeline('short_film', { durationMs: 90_000 }),
  };

  it("reads the directed production's template, tone and length through the owner-scoped compositions", async () => {
    const get = vi.fn().mockResolvedValue(film);
    expect(await loadDirectorBriefing({ productionCompositionId: compositionId }, { get }, logger())).toEqual({
      template: 'short_film',
      tone: 'wistful',
      durationMs: 90_000,
    });
    expect(get).toHaveBeenCalledWith(compositionId);
  });

  it('falls back to the ad context, with a warning, when the production cannot be read', async () => {
    const log = logger();
    const get = vi.fn().mockRejectedValue(new NotFoundError('Composition not found'));
    const briefing = await loadDirectorBriefing({ productionCompositionId: compositionId }, { get }, log);
    expect(briefing).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('directing it as an ad'), {
      error: 'Composition not found',
    });
    expect(
      withDirectedSystemContext(undefined, {
        productionCompositionId: compositionId,
        productionToolsReady: true,
        briefing,
      })
    ).toBe(buildDirectorSystemContext(compositionId));
  });

  it('reports a non-Error failure as text', async () => {
    const log = logger();
    const get = vi.fn().mockRejectedValue('db down');
    expect(await loadDirectorBriefing({ productionCompositionId: compositionId }, { get }, log)).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), { error: 'db down' });
  });

  it('reads nothing for an undirected run, an API-key run, or a run without the production tools', async () => {
    const get = vi.fn().mockResolvedValue(film);
    expect(await loadDirectorBriefing({}, { get }, logger())).toBeUndefined();
    expect(
      await loadDirectorBriefing({ productionCompositionId: compositionId, apiKeyId: 'k1' }, { get }, logger())
    ).toBeUndefined();
    expect(await loadDirectorBriefing({ productionCompositionId: compositionId }, undefined, logger())).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });
});

describe('directedFinalCheck', () => {
  const directed = { productionCompositionId: compositionId, productionToolsReady: true };

  it('sends a first-iteration answer back once, and lets later answers and tool turns through', async () => {
    const first = directedFinalCheck(directed, 0);
    expect(await first?.('final')).toBe(DIRECTED_NO_TOOL_CHECK);
    expect(await first?.('turn')).toBeNull();
    expect(await directedFinalCheck(directed, 1)?.('final')).toBeNull();
  });

  it('sends the check only once even if the final phase repeats', async () => {
    const check = directedFinalCheck(directed, 0);
    expect(await check?.('final')).toBe(DIRECTED_NO_TOOL_CHECK);
    expect(await check?.('final')).toBeNull();
  });

  it('is absent for an undirected run, an API-key run or one without the production tools', () => {
    expect(directedFinalCheck({ productionToolsReady: true }, 0)).toBeUndefined();
    expect(directedFinalCheck({ ...directed, apiKeyId: 'key1' }, 0)).toBeUndefined();
    expect(directedFinalCheck({ ...directed, productionToolsReady: false }, 0)).toBeUndefined();
  });
});
