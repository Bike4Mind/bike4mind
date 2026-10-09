import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithModelOverride, type ModelOverrideContext } from './modelOverride';
import { useCliStore } from '../store';
import type { Session } from '../storage';

const ISO = '2026-01-01T00:00:00.000Z';
const ORIGINAL_MODEL = 'claude-sonnet-5-5';
const OVERRIDE_MODEL = 'claude-haiku-4-5-20251001';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    name: 'test session',
    createdAt: ISO,
    updatedAt: ISO,
    model: ORIGINAL_MODEL,
    messages: [],
    metadata: { totalTokens: 0, totalCost: 0, toolCallCount: 0 },
    ...overrides,
  };
}

/** Mirrors `applyModelToSession`: installs a new session reference with the model. */
function makeContext() {
  const appliedModels: string[] = [];
  const save = vi.fn<(session: Session) => Promise<void>>(async () => undefined);
  const ctx: ModelOverrideContext = {
    sessionStore: { save },
    applyModel: modelId => {
      appliedModels.push(modelId);
      const current = useCliStore.getState().session;
      if (current) useCliStore.getState().setSession({ ...current, model: modelId });
    },
  };
  return { ...ctx, appliedModels, save };
}

/** Stand-in for a custom-command turn: replaces the store session and persists it. */
async function simulateTurn(ctx: ReturnType<typeof makeContext>): Promise<string | undefined> {
  const current = useCliStore.getState().session;
  if (!current) return undefined;
  const finalSession = {
    ...current,
    messages: [...current.messages, { id: 'm1', role: 'user' as const, content: 'hi', timestamp: ISO }],
  };
  useCliStore.getState().setSession(finalSession);
  await ctx.save(finalSession);
  return current.model;
}

function lastSaved(ctx: ReturnType<typeof makeContext>): Session | undefined {
  const calls = ctx.save.mock.calls;
  return calls[calls.length - 1]?.[0];
}

describe('runWithModelOverride', () => {
  beforeEach(() => {
    useCliStore.getState().setSession(makeSession());
  });

  it('runs the turn on the override model through applyModel', async () => {
    const ctx = makeContext();

    const modelDuringTurn = await runWithModelOverride(ctx, OVERRIDE_MODEL, () => simulateTurn(ctx));

    expect(modelDuringTurn).toBe(OVERRIDE_MODEL);
    expect(ctx.appliedModels).toEqual([OVERRIDE_MODEL, ORIGINAL_MODEL]);
  });

  it('restores the original model on the session the turn installed, and persists it', async () => {
    const ctx = makeContext();

    await runWithModelOverride(ctx, OVERRIDE_MODEL, () => simulateTurn(ctx));

    const storeSession = useCliStore.getState().session;
    expect(storeSession?.model).toBe(ORIGINAL_MODEL);
    expect(storeSession?.messages).toHaveLength(1);
    const saved = lastSaved(ctx);
    expect(saved?.model).toBe(ORIGINAL_MODEL);
    expect(saved?.messages).toHaveLength(1);
  });

  it('restores and persists the original model when the turn throws', async () => {
    const ctx = makeContext();

    await expect(
      runWithModelOverride(ctx, OVERRIDE_MODEL, async () => {
        await simulateTurn(ctx);
        throw new Error('turn failed');
      })
    ).rejects.toThrow('turn failed');

    expect(useCliStore.getState().session?.model).toBe(ORIGINAL_MODEL);
    expect(lastSaved(ctx)?.model).toBe(ORIGINAL_MODEL);
  });

  it('skips the restore when there was no session to restore', async () => {
    useCliStore.getState().setSession(null);
    const ctx = makeContext();

    await runWithModelOverride(ctx, OVERRIDE_MODEL, async () => undefined);

    expect(ctx.appliedModels).toEqual([OVERRIDE_MODEL]);
    expect(ctx.save).not.toHaveBeenCalled();
  });
});
