// Core's own tutorials wired to the shared library: its models, content, service and access rule.
import type { Request } from 'express';
import { isFullAdmin } from '@bike4mind/common';
import type { EntitlementUser } from '@bike4mind/server-utils/entitlements/index';
import { coreTutorialDepsFor } from './coreDeps';
import { coreKnownSelectors } from './coreDraftProfile';
import { CORE_TUTORIAL_CONTENT } from './content';
import { CORE_TUTORIAL_SETTING } from './settingName';
import { tutorialContent } from './effectiveModules';
import { tutorialModels } from './models';
import type { FieldMap } from './overrides';
import { CORE_TUTORIALS, resolveCoreTutorial } from './registry';
import type { TutorialSummary } from './routes';
import { tutorialService } from './service';
import { coreTutorialVisibleTo, filterCoreTutorialsVisibleTo } from './visibility';
import type { TutorialModule } from './types';
import editableFields from './editableFields.json';

export { CORE_TUTORIAL_SETTING };

export const coreModels = tutorialModels({ prefix: '', modelPrefix: 'Core' });
export { coreKnownSelectors };
export const coreOverridePolicy = { editable: editableFields as FieldMap };

export const coreContent = tutorialContent({
  models: coreModels,
  repo: CORE_TUTORIAL_CONTENT,
  policy: coreOverridePolicy,
  validator: { known: coreKnownSelectors },
});

export const isCoreAdmin = (req: Request) => isFullAdmin(req.user);

/**
 * The service over what this user may run: content that core's registry names, that is switched on there, and
 * that the user may see. Everything else is absent, so it answers exactly like an id nobody ever heard of.
 */
export async function coreServiceFor(req: Request) {
  const visible = new Set((await filterCoreTutorialsVisibleTo(req.user!, CORE_TUTORIALS)).map(t => t.id));
  const { modules } = await coreContent.resolve();
  return tutorialService({
    modules: [
      ...modules.filter(m => visible.has(m.id) && resolveCoreTutorial(m.id)?.enabled),
      ...(await coreDraftModules(req.user!)),
    ],
    models: coreModels,
    deps: coreTutorialDepsFor(req),
  });
}

/** Core drafts a learner may run: servable, and visible to this user. */
export async function coreDraftModules(user: EntitlementUser): Promise<TutorialModule[]> {
  // Loaded here: coreDrafts imports this file for the models and selectors it shares.
  const { coreDraftStore } = await import('./coreDrafts');
  const drafts = await coreDraftStore.servable();
  const visible = await Promise.all(
    drafts.map(({ row }) => !!row.visibility && coreTutorialVisibleTo(user, row.visibility))
  );
  return drafts.filter((_, i) => visible[i]).map(({ module }) => module);
}

export async function coreSummary(): Promise<TutorialSummary[]> {
  const { modules } = coreContent.effectiveTutorials(await coreContent.readOverrides());
  return CORE_TUTORIALS.map(t => ({
    id: t.id,
    title: t.title,
    enabled: t.enabled && !!modules.find(m => m.id === t.id)?.enabled,
  }));
}
