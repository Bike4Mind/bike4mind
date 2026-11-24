import { describe, it, expect } from 'vitest';
import { DIRECTOR_TOOLS, buildDirectorSystemContext } from '@bike4mind/common';
import {
  DIRECTED_NO_TOOL_CHECK,
  directedFinalCheck,
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
