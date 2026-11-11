// Core tutorial turns for the chat path. Reached only for a session carrying a core marker (see
// respondFromCoreTutorial), so ordinary chat never loads or reads any of this.
import type {
  CoreTutorialTurnContext,
  CoreTutorialTurnHook,
  IUserDocument,
  WorkspaceTurnReply,
} from '@bike4mind/common';
import { sessionRepository } from '@bike4mind/database';
import { isFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { CORE_TUTORIAL_SETTING } from './settingName';
import { resolveCoreTutorial } from './registry';
import { coreTutorialVisibleTo } from './visibility';

// Loaded on first use: core.ts pulls in the session and sheet deps the chat path has no need for.
async function turnsFor(ctx: Omit<CoreTutorialTurnContext, 'quest'>) {
  const moduleId = ctx.session.tutorial?.moduleId;
  if (ctx.session.tutorial?.owner !== 'core' || !moduleId) return undefined;
  if (!(await isFeatureEnabled(CORE_TUTORIAL_SETTING))) return undefined;
  const tutorial = resolveCoreTutorial(moduleId);
  if (!tutorial?.enabled || !(await coreTutorialVisibleTo(ctx.user as IUserDocument, tutorial.visibility))) {
    return undefined;
  }
  const { coreContent, coreModels } = await import('./core');
  const { modules } = await coreContent.resolve();
  const { tutorialTurnService } = await import('./service');
  // The one module the marker names: a stale marker never reaches another walk.
  return tutorialTurnService({
    modules: modules.filter(m => m.id === moduleId),
    models: coreModels,
    // Clears the marker when the script ends the walk, so later turns skip this check.
    setSessionMarker: async (sessionId, userId) => {
      if (!(await sessionRepository.findByIdAndUserId(sessionId, userId))) return;
      await sessionRepository.update({ id: sessionId, tutorial: null });
    },
    warn: message => ctx.logger?.warn(message),
  });
}

export const coreTutorialTurns: CoreTutorialTurnHook = {
  respond: async ctx => {
    const { id, prompt } = ctx.quest;
    if (!id) return null;
    const turns = await turnsFor(ctx);
    // The recorded side effects are authored as plain {type, payload} pairs; the chat quest types them tighter.
    return ((await turns?.answerTurn((ctx.user as IUserDocument).id, ctx.session.id, { id, prompt })) ??
      null) as WorkspaceTurnReply | null;
  },
  answersTurns: async ctx => {
    const turns = await turnsFor(ctx);
    return (await turns?.sessionIsScripted((ctx.user as IUserDocument).id, ctx.session.id)) ?? false;
  },
};
