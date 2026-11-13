// Core tutorial turns for the chat path. Reached only for a session carrying a core marker (see
// respondFromCoreTutorial), so ordinary chat never loads or reads any of this.
import type {
  CoreTutorialTurnContext,
  CoreTutorialTurnHook,
  IUserDocument,
  WorkspaceTurnReply,
} from '@bike4mind/common';
import { isFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { CORE_TUTORIAL_SETTING } from './settingName';
import { setCoreSessionMarker } from './sessionMarker';
import { resolveCoreTutorial } from './registry';
import type { TutorialModule } from './types';
import { coreTutorialVisibleTo } from './visibility';

// Loaded on first use: core.ts pulls in the session and sheet deps the chat path has no need for.
async function turnsFor(ctx: Omit<CoreTutorialTurnContext, 'quest'>) {
  const moduleId = ctx.session.tutorial?.moduleId;
  if (ctx.session.tutorial?.owner !== 'core' || !moduleId) return undefined;
  if (!(await isFeatureEnabled(CORE_TUTORIAL_SETTING))) return undefined;
  const user = ctx.user as IUserDocument;
  const tutorial = resolveCoreTutorial(moduleId);
  let served: TutorialModule[];
  if (tutorial) {
    if (!tutorial.enabled || !(await coreTutorialVisibleTo(user, tutorial.visibility))) return undefined;
    const { coreContent } = await import('./core');
    // The one module the marker names: a stale marker never reaches another walk.
    served = (await coreContent.resolve()).modules.filter(m => m.id === moduleId);
  } else {
    const { coreDraftStore } = await import('./coreDrafts');
    const draft = await coreDraftStore.servableById(moduleId);
    if (!draft?.row.visibility || !(await coreTutorialVisibleTo(user, draft.row.visibility))) return undefined;
    served = [draft.module];
  }
  const { coreModels } = await import('./core');
  const { tutorialTurnService } = await import('./service');
  return tutorialTurnService({
    modules: served,
    models: coreModels,
    // Clears the marker when the script ends the walk, so later turns skip this check.
    setSessionMarker: setCoreSessionMarker,
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
