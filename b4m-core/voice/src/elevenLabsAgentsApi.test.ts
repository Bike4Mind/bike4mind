import { describe, it, expect } from 'vitest';
import { updateElevenLabsAgent } from './elevenLabsAgentsApi';

/**
 * updateElevenLabsAgent must treat both turn-taking fields symmetrically -
 * each is only sent when the caller specifies it, so a partial update that omits
 * them leaves the existing agent/dashboard values intact (PATCH semantics). The
 * bug was that turn_timeout was always re-asserted (with a default) while
 * turn_eagerness was conditional, so an omit-both update silently reset the timeout.
 */

interface CapturedBody {
  name?: string;
  conversation_config: { turn?: Record<string, unknown>; [key: string]: unknown };
}
interface Captured {
  body: CapturedBody;
}

/** A fetch stub that records the PATCH body and reports success. */
function makeFetchImpl(captured: Captured): typeof fetch {
  return (async (_url: string, opts: { body: string }) => {
    captured.body = JSON.parse(opts.body) as CapturedBody;
    return { ok: true, status: 200, text: async () => '' } as Response;
  }) as unknown as typeof fetch;
}

const turnOf = (captured: Captured) => captured.body?.conversation_config?.turn;

describe('updateElevenLabsAgent turn-taking config (#8879)', () => {
  it('omits the turn block entirely when neither turn field is provided', async () => {
    const captured = {} as Captured;
    await updateElevenLabsAgent('k', 'agent-1', { systemPrompt: 'hi', fetchImpl: makeFetchImpl(captured) });

    expect('turn' in captured.body.conversation_config).toBe(false);
  });

  it('sends only turn_timeout when only turnTimeoutSeconds is provided', async () => {
    const captured = {} as Captured;
    await updateElevenLabsAgent('k', 'agent-1', { turnTimeoutSeconds: 20, fetchImpl: makeFetchImpl(captured) });

    expect(turnOf(captured)).toEqual({ turn_timeout: 20 });
  });

  it('sends only turn_eagerness when only turnEagerness is provided', async () => {
    const captured = {} as Captured;
    await updateElevenLabsAgent('k', 'agent-1', { turnEagerness: 'eager', fetchImpl: makeFetchImpl(captured) });

    expect(turnOf(captured)).toEqual({ turn_eagerness: 'eager' });
  });

  it('sends both turn fields when both are provided', async () => {
    const captured = {} as Captured;
    await updateElevenLabsAgent('k', 'agent-1', {
      turnTimeoutSeconds: 15,
      turnEagerness: 'patient',
      fetchImpl: makeFetchImpl(captured),
    });

    expect(turnOf(captured)).toEqual({ turn_timeout: 15, turn_eagerness: 'patient' });
  });

  it('does not reset turn_timeout on an unrelated partial update (the #8879 regression)', async () => {
    const captured = {} as Captured;
    await updateElevenLabsAgent('k', 'agent-1', { firstMessage: 'hello', fetchImpl: makeFetchImpl(captured) });

    // Previously this sent turn: { turn_timeout: 10 }, clobbering the agent's value.
    expect('turn' in captured.body.conversation_config).toBe(false);
  });
});
