import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { B4MLLMTools } from '@bike4mind/common';

// Controllable LLM-store state. The hook reads it via `useLLM(useShallow(...))`;
// the mock applies the (shallow-wrapped) selector to this object.
const llmState = {
  temperature: undefined as number | undefined,
  top_p: undefined as number | undefined,
  n: undefined as number | undefined,
  toolMode: 'smart' as 'smart' | 'fast',
  tools: [] as B4MLLMTools[],
};

vi.mock('@client/app/contexts/LLMContext', () => ({
  useLLM: (selector: (s: typeof llmState) => unknown) => selector(llmState),
}));

const userState = { currentUser: { preferences: { hiddenSurfaces: [] as string[] } } };
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector: (s: typeof userState) => unknown) => selector(userState),
}));

const { toastInfo, toastError } = vi.hoisted(() => ({ toastInfo: vi.fn(), toastError: vi.fn() }));
vi.mock('sonner', () => ({
  toast: { info: (m: string) => toastInfo(m), error: (m: string) => toastError(m) },
}));

const { recommendToolsMock, mergeToolsMock } = vi.hoisted(() => ({
  recommendToolsMock: vi.fn(),
  mergeToolsMock: vi.fn(),
}));
vi.mock('@client/app/utils/toolRecommender', () => ({
  recommendTools: (p: string) => recommendToolsMock(p),
  mergeTools: (r: unknown, t: unknown) => mergeToolsMock(r, t),
}));

import { useLLMSettingsAssembly } from '../useLLMSettingsAssembly';

const render = () => renderHook(() => useLLMSettingsAssembly()).result;

beforeEach(() => {
  vi.clearAllMocks();
  llmState.temperature = undefined;
  llmState.top_p = undefined;
  llmState.n = undefined;
  llmState.toolMode = 'smart';
  llmState.tools = [];
  userState.currentUser.preferences.hiddenSurfaces = [];
});

describe('useLLMSettingsAssembly › assembleSettings', () => {
  it('forwards store sampling params, stream, and clamped max_tokens', () => {
    llmState.temperature = 0.5;
    llmState.top_p = 0.8;
    llmState.n = 3;

    const settings = render().current.assembleSettings({ stream: true, safeMaxTokens: 4096 });

    expect(settings).toEqual({
      temperature: 0.5,
      top_p: 0.8,
      n: 3,
      stream: true,
      stop: null,
      max_tokens: 4096,
      presence_penalty: 0,
      frequency_penalty: 0,
      logit_bias: {},
    });
  });

  it('applies defaults (0.9 / 1 / 1) when sampling params are undefined', () => {
    const settings = render().current.assembleSettings({ stream: false, safeMaxTokens: 100 });

    expect(settings.temperature).toBe(0.9);
    expect(settings.top_p).toBe(1);
    expect(settings.n).toBe(1);
    expect(settings.stream).toBe(false);
    expect(settings.max_tokens).toBe(100);
  });
});

describe('useLLMSettingsAssembly › resolveTools', () => {
  it('returns no tools (and never refuses) when the model cannot run tools', () => {
    llmState.tools = ['web_search'] as B4MLLMTools[];
    const result = render().current.resolveTools({ prompt: 'hi', supportsTools: false });

    expect(result).toEqual({ effectiveTools: [], refused: false });
    expect(recommendToolsMock).not.toHaveBeenCalled();
  });

  it('Smart mode merges recommendations and toasts only the auto-selected ones', () => {
    llmState.toolMode = 'smart';
    llmState.tools = ['web_search'] as B4MLLMTools[];
    recommendToolsMock.mockReturnValue([
      { tool: 'web_search', reason: 'already selected' },
      { tool: 'web_fetch', reason: 'fetch a URL' },
    ]);
    mergeToolsMock.mockReturnValue(['web_search', 'web_fetch'] as B4MLLMTools[]);

    const result = render().current.resolveTools({ prompt: 'open example.com', supportsTools: true });

    expect(result).toEqual({ effectiveTools: ['web_search', 'web_fetch'], refused: false });
    // Only `web_fetch` is newly auto-selected (web_search was already in `tools`).
    expect(toastInfo).toHaveBeenCalledTimes(1);
    expect(toastInfo).toHaveBeenCalledWith('Smart tools: fetch a URL');
  });

  describe('Smart mode with session-denied tools', () => {
    const recommend = () => {
      llmState.toolMode = 'smart';
      llmState.tools = ['web_search'] as B4MLLMTools[];
      recommendToolsMock.mockReturnValue([
        { tool: 'dice_roll', reason: 'roll some dice' },
        { tool: 'web_fetch', reason: 'fetch a URL' },
      ]);
      mergeToolsMock.mockReturnValue(['web_search', 'dice_roll', 'web_fetch'] as B4MLLMTools[]);
    };

    it('does not name a denied tool in the toast', () => {
      recommend();
      render().current.resolveTools({ prompt: 'x', supportsTools: true, deniedTools: ['dice_roll'] });
      expect(toastInfo).toHaveBeenCalledTimes(1);
      expect(toastInfo).toHaveBeenCalledWith('Smart tools: fetch a URL');
    });

    it('does not toast at all when the only new recommendation is denied', () => {
      llmState.toolMode = 'smart';
      llmState.tools = ['web_search'] as B4MLLMTools[];
      recommendToolsMock.mockReturnValue([{ tool: 'dice_roll', reason: 'roll some dice' }]);
      mergeToolsMock.mockReturnValue(['web_search', 'dice_roll'] as B4MLLMTools[]);
      render().current.resolveTools({ prompt: 'x', supportsTools: true, deniedTools: ['dice_roll'] });
      expect(toastInfo).not.toHaveBeenCalled();
    });

    // The server denylist is the gate; the client payload is deliberately left alone.
    it('still sends the denied tool in effectiveTools', () => {
      recommend();
      const result = render().current.resolveTools({ prompt: 'x', supportsTools: true, deniedTools: ['dice_roll'] });
      expect(result.effectiveTools).toEqual(['web_search', 'dice_roll', 'web_fetch']);
    });

    // Control: without a denylist the same recommendations are all named.
    it('names every recommendation when no denylist is given', () => {
      recommend();
      render().current.resolveTools({ prompt: 'x', supportsTools: true });
      expect(toastInfo).toHaveBeenCalledWith('Smart tools: roll some dice, fetch a URL');
    });
  });

  it('Smart mode does not toast when nothing new was auto-selected', () => {
    llmState.toolMode = 'smart';
    llmState.tools = ['web_search'] as B4MLLMTools[];
    recommendToolsMock.mockReturnValue([{ tool: 'web_search', reason: 'already selected' }]);
    mergeToolsMock.mockReturnValue(['web_search'] as B4MLLMTools[]);

    render().current.resolveTools({ prompt: 'x', supportsTools: true });

    expect(toastInfo).not.toHaveBeenCalled();
  });

  it('skipAutoOffers skips the recommender entirely in Smart mode - only the picked tools ride', () => {
    llmState.toolMode = 'smart';
    llmState.tools = ['web_search'] as B4MLLMTools[];

    const result = render().current.resolveTools({
      prompt: 'search my documents for the Q3 report',
      supportsTools: true,
      skipAutoOffers: true,
    });

    expect(result).toEqual({ effectiveTools: ['web_search'], refused: false });
    expect(recommendToolsMock).not.toHaveBeenCalled();
    expect(mergeToolsMock).not.toHaveBeenCalled();
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it('Fast mode strips all tools', () => {
    llmState.toolMode = 'fast';
    llmState.tools = ['web_search'] as B4MLLMTools[];

    const result = render().current.resolveTools({ prompt: 'x', supportsTools: true });

    expect(result).toEqual({ effectiveTools: [], refused: false });
    expect(recommendToolsMock).not.toHaveBeenCalled();
  });

  it('briefcase override on a tool-capable model wins and short-circuits the Smart ladder', () => {
    // The override short-circuits the ladder entirely: recommendTools is NOT run and
    // the "Smart tools" toast does NOT fire for tools the override would only replace.
    llmState.toolMode = 'smart';
    llmState.tools = [] as B4MLLMTools[];

    const result = render().current.resolveTools({
      prompt: 'x',
      supportsTools: true,
      toolsOverride: ['web_search'] as B4MLLMTools[],
    });

    expect(result).toEqual({ effectiveTools: ['web_search'], refused: false });
    expect(recommendToolsMock).not.toHaveBeenCalled();
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it('briefcase override on a non-tool model REFUSES the send and toasts an error', () => {
    const result = render().current.resolveTools({
      prompt: 'x',
      supportsTools: false,
      toolsOverride: ['web_search'] as B4MLLMTools[],
    });

    expect(result.refused).toBe(true);
    expect(result.effectiveTools).toEqual([]);
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('requires tools (web_search) that'));
  });

  it('refusal message omits the empty parenthetical when the override is fully stripped', () => {
    // Every requested tool is integration-gated (BRIEFCASE_DISALLOWED_TOOLS), so the
    // override strips to []. On a non-tool model the refusal must NOT read "tools ()".
    const result = render().current.resolveTools({
      prompt: 'x',
      supportsTools: false,
      toolsOverride: ['blog_publish'] as B4MLLMTools[],
    });

    expect(result.refused).toBe(true);
    expect(toastError).toHaveBeenCalledTimes(1);
    const msg = toastError.mock.calls[0][0] as string;
    expect(msg).not.toMatch(/\(\s*\)/); // no "()" or "( )"
    expect(msg).toContain('requires tools that the current model');
  });
});

describe('useLLMSettingsAssembly - resolveTools with a hidden workspace', () => {
  const OPTI_TOOL = 'optihashi_schedule' as B4MLLMTools;

  beforeEach(() => {
    userState.currentUser.preferences.hiddenSurfaces = ['opti'];
    llmState.toolMode = 'smart';
  });

  it('never auto-recommends or toasts a hidden-surface tool outside that surface', () => {
    recommendToolsMock.mockReturnValue([{ tool: OPTI_TOOL, reason: 'Optimization Solver' }]);
    mergeToolsMock.mockImplementation((recs: { tool: B4MLLMTools }[], tools: B4MLLMTools[]) => [
      ...tools,
      ...recs.map(r => r.tool),
    ]);

    const result = render().current.resolveTools({ prompt: 'optimize my shifts', supportsTools: true });

    expect(result.effectiveTools).not.toContain(OPTI_TOOL);
    expect(mergeToolsMock).toHaveBeenCalledWith([], []);
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it('drops a pinned hidden-surface tool from the send outside that surface', () => {
    llmState.tools = ['web_search', OPTI_TOOL] as B4MLLMTools[];
    recommendToolsMock.mockReturnValue([]);
    mergeToolsMock.mockReturnValue(['web_search', OPTI_TOOL] as B4MLLMTools[]);

    const result = render().current.resolveTools({ prompt: 'x', supportsTools: true, activeSurface: null });

    expect(result.effectiveTools).toEqual(['web_search']);
  });

  it('keeps a hidden-surface tool a briefcase override names explicitly', () => {
    const result = render().current.resolveTools({
      prompt: 'x',
      supportsTools: true,
      toolsOverride: [OPTI_TOOL],
      activeSurface: null,
    });

    expect(result).toEqual({ effectiveTools: [OPTI_TOOL], refused: false });
    expect(recommendToolsMock).not.toHaveBeenCalled();
  });

  it('keeps a pinned hidden-surface tool when auto-offers are off', () => {
    llmState.tools = [OPTI_TOOL] as B4MLLMTools[];

    const result = render().current.resolveTools({ prompt: 'x', supportsTools: true, skipAutoOffers: true });

    expect(result.effectiveTools).toEqual([OPTI_TOOL]);
  });

  it('keeps the tool for a session inside that surface', () => {
    llmState.tools = [OPTI_TOOL] as B4MLLMTools[];
    recommendToolsMock.mockReturnValue([]);
    mergeToolsMock.mockReturnValue([OPTI_TOOL] as B4MLLMTools[]);

    const result = render().current.resolveTools({ prompt: 'x', supportsTools: true, activeSurface: 'opti' });

    expect(result.effectiveTools).toEqual([OPTI_TOOL]);
  });

  it('keeps the tool again once the surface is unhidden', () => {
    userState.currentUser.preferences.hiddenSurfaces = [];
    llmState.tools = [OPTI_TOOL] as B4MLLMTools[];
    recommendToolsMock.mockReturnValue([]);
    mergeToolsMock.mockReturnValue([OPTI_TOOL] as B4MLLMTools[]);

    const result = render().current.resolveTools({ prompt: 'x', supportsTools: true });

    expect(result.effectiveTools).toEqual([OPTI_TOOL]);
  });
});
