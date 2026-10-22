/**
 * Run one unit of work (a custom command turn) on a temporary model, then put
 * the session back on the model it had before.
 *
 * The override goes through `applyModel` - in `index.tsx` that is
 * `applyModelToSession`, which updates the store session, the agent context and
 * the LLM backend together. Mutating `session.model` alone never reached the
 * agent, and the turn installs new session references in the store, so the
 * restore must read the *current* store session rather than a captured one.
 * The turn persists the session while the override is active, so the restored
 * session is saved again; otherwise the override would survive a resume.
 */
import type { SessionStore } from '../storage';
import { useCliStore } from '../store';

export type ModelOverrideContext = {
  /** Point the session, agent and backend at `modelId` (see `applyModelToSession`). */
  applyModel: (modelId: string) => void;
  sessionStore: Pick<SessionStore, 'save'>;
};

export async function runWithModelOverride<T>(
  ctx: ModelOverrideContext,
  overrideModel: string,
  run: () => Promise<T>
): Promise<T> {
  const originalModel = useCliStore.getState().session?.model;
  ctx.applyModel(overrideModel);

  try {
    return await run();
  } finally {
    if (originalModel) {
      await restoreModel(ctx, originalModel);
    }
  }
}

async function restoreModel(ctx: ModelOverrideContext, originalModel: string): Promise<void> {
  ctx.applyModel(originalModel);
  const restoredSession = useCliStore.getState().session;
  if (restoredSession) {
    await ctx.sessionStore.save(restoredSession);
  }
}
