// Core's own tutorials wired to the shared library: its models, content, service and access rule.
import type { Request } from 'express';
import { isFullAdmin } from '@bike4mind/common';
import { coreTutorialDepsFor } from './coreDeps';
import { CORE_TUTORIAL_CONTENT } from './content';
import { tutorialContent } from './effectiveModules';
import { tutorialModels } from './models';
import type { FieldMap } from './overrides';
import { CORE_TUTORIALS, resolveCoreTutorial } from './registry';
import type { TutorialSummary } from './routes';
import { tutorialService } from './service';
import { knownSelectorsOf } from './validate';
import { filterCoreTutorialsVisibleTo } from './visibility';
import editableFields from './editableFields.json';

export const CORE_TUTORIAL_SETTING = 'EnableCoreTutorials' as const;

export const coreModels = tutorialModels({ prefix: '', modelPrefix: 'Core' });
export const coreKnownSelectors = knownSelectorsOf(CORE_TUTORIAL_CONTENT.map(t => ({ steps: [...t.steps] })));
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
    modules: modules.filter(m => visible.has(m.id) && resolveCoreTutorial(m.id)?.enabled),
    models: coreModels,
    deps: coreTutorialDepsFor(req),
  });
}

export async function coreSummary(): Promise<TutorialSummary[]> {
  const { modules } = coreContent.effectiveTutorials(await coreContent.readOverrides());
  return CORE_TUTORIALS.map(t => ({
    id: t.id,
    title: t.title,
    enabled: t.enabled && !!modules.find(m => m.id === t.id)?.enabled,
  }));
}
