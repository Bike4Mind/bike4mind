// Writes server/tutorials/editableFields.json: per module, per step, the copy fields its steps.ts writes as a
// plain string literal. Run `pnpm --filter client tutorials:fields` after editing a module's steps.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_TUTORIAL_CONTENT } from '../server/tutorials/content';
import { CORE_MODULES_DIR } from '../server/tutorials/apply/coreLayout';
import { renderEditableFields } from '../server/tutorials/editableFields';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const EDITABLE_FIELDS_PATH = join(REPO_ROOT, 'apps/client/server/tutorials/editableFields.json');

export const renderCoreEditableFields = (root: string = REPO_ROOT) =>
  renderEditableFields(
    root,
    CORE_TUTORIAL_CONTENT.map(t => ({
      id: t.intro.id,
      stepIds: t.steps.map(s => s.id),
      stepsFile: join(CORE_MODULES_DIR, t.intro.id, 'steps.ts'),
    }))
  );

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(EDITABLE_FIELDS_PATH, renderCoreEditableFields());
  console.log(`wrote ${EDITABLE_FIELDS_PATH}`);
}
