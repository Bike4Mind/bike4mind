// Core's layout for the apply library. Imports only what the draft profile needs, never the database.
import { join } from 'node:path';
import type { TutorialDraftContent } from '@bike4mind/common';
import { CORE_TUTORIAL_CONTENT } from '@bike4mind/server-utils/tutorials/content';
import { coreDraftCore } from '@bike4mind/server-utils/tutorials/coreDraftProfile';
import { CORE_EDITABLE_FIELDS } from '@bike4mind/server-utils/tutorials/coreEditableFields';
import { escapeNonAscii, identifiersOf, type ModuleFiles, type TutorialRepoLayout } from './layout';

export const CORE_OWNER = 'core';
export const CORE_MODULES_DIR = 'packages/server-utils/src/tutorials/modules';

/** JSON with every non-ASCII character escaped, so a captured sheet or reply keeps its text and the file stays ASCII. */
const json = (value: unknown, indent?: number) => escapeNonAscii(JSON.stringify(value, null, indent));
// Identifier keys unquoted, as the AST readers of steps.ts (editable fields, override apply) only match those.
const literal = (value: unknown) => json(value, 2).replace(/^(\s*)"([A-Za-z_$][\w$]*)":/gm, '$1$2:');
const inline = (value: object | undefined) =>
  value
    ? `{ ${Object.entries(value)
        .map(([k, v]) => `${k}: ${json(v)}`)
        .join(', ')} }`
    : 'undefined';

/** The files of a made core module in `dir`, and the registry and content entries a person places by hand. */
export function coreModuleFiles(dir: string, authored: TutorialDraftContent): ModuleFiles {
  // A core draft has no canvas, so the content's canvas type is never read.
  const content = authored as TutorialDraftContent<{ turn: number }>;
  const issues = coreDraftCore.validateDraft(content);
  const { upper, camel } = identifiersOf(content.moduleId);
  const { module } = coreDraftCore.draftModule(content, { revision: 0, enabled: true });
  const { sheet } = content;

  const files: Array<[string, string]> = [
    ...(sheet
      ? [
          [
            join(dir, 'sheet.ts'),
            `export const ${upper}_SHEET_NAME = ${json(sheet.name)};\n\nexport const ${upper}_SHEET_CSV = ${json(sheet.csv)};\n`,
          ] as [string, string],
        ]
      : []),
    [
      join(dir, 'module.ts'),
      [
        `import type { TutorialModuleIntro } from '../../types';`,
        ...(sheet ? [`import { ${upper}_SHEET_CSV, ${upper}_SHEET_NAME } from './sheet';`] : []),
        '',
        `export const ${camel}Module: TutorialModuleIntro = {`,
        `  id: ${json(content.moduleId)},`,
        `  title: ${json(content.title)},`,
        `  pitch: ${json(content.pitch)},`,
        `  openingPrompt: ${json(module.openingPrompt)},`,
        ...(sheet ? [`  sheet: { name: ${upper}_SHEET_NAME, csv: ${upper}_SHEET_CSV },`] : []),
        '};',
        '',
      ].join('\n'),
    ],
    [
      join(dir, 'steps.ts'),
      `import type { TutorialStep } from '@bike4mind/common';\n\nexport const ${upper}_STEPS: TutorialStep[] = ${literal(coreDraftCore.normalizeDraftSteps(content))};\n`,
    ],
    [join(dir, 'transcript.json'), `${json(content.transcript, 2)}\n`],
  ];

  const at = `./modules/${content.moduleId}`;
  const registry = [
    `  { id: ${json(content.moduleId)}, title: ${json(content.title)}, visibility: ${inline(content.visibility)}, enabled: false },`,
  ].join('\n');
  const contentEntry = [
    `import { ${camel}Module } from '${at}/module';`,
    `import { ${upper}_STEPS } from '${at}/steps';`,
    `import ${camel}Transcript from '${at}/transcript.json';`,
    '',
    `  { intro: ${camel}Module, version: 1, enabled: true, steps: ${upper}_STEPS, transcript: ${camel}Transcript },`,
  ].join('\n');

  return {
    dir,
    files,
    issues,
    registration: [
      { file: 'packages/server-utils/src/tutorials/registry.ts', text: registry },
      { file: 'packages/server-utils/src/tutorials/content.ts', text: contentEntry },
    ],
  };
}

export function coreLayout(root: string): TutorialRepoLayout {
  return {
    owner: CORE_OWNER,
    repoOf: owner => (owner === CORE_OWNER ? 'bike4mind' : undefined),
    root,
    modulesDir: CORE_MODULES_DIR,
    version: {
      path: 'packages/server-utils/src/tutorials/content.ts',
      arrayName: 'CORE_TUTORIAL_CONTENT',
      locate: 'introId',
    },
    repoModules: () =>
      CORE_TUTORIAL_CONTENT.map((t, index) => ({ id: t.intro.id, version: t.version, index, steps: t.steps })),
    policy: { editable: CORE_EDITABLE_FIELDS },
    header: '',
    moduleFiles: (content, dir) => coreModuleFiles(dir, content),
    registers: ['packages/server-utils/src/tutorials/registry.ts', 'packages/server-utils/src/tutorials/content.ts'],
    fieldsCommand: 'pnpm --filter client tutorials:fields',
    guard: { cwd: 'packages/server-utils', test: 'src/tutorials/__tests__/validate.test.ts' },
    specsDir: 'apps/client/e2e',
  };
}
