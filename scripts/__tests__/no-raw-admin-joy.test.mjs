import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint, RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { afterAll, describe, expect, it } from 'vitest';
import rule from '../../eslint-rules/no-raw-admin-joy.mjs';
import legacy from '../../eslint-rules/admin-joy-legacy.mjs';
import imports from '../../eslint-rules/admin-joy-legacy-imports.mjs';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.afterAll = afterAll;

const root = fileURLToPath(new URL('../../', import.meta.url));
const admin = path.join(root, 'apps/client/app/components/admin');
const filename = path.join(admin, 'NewTab.tsx');
const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });
const valid = code => ({ code, filename });
const invalid = (code, components = ['Modal'], file = filename) => ({
  code,
  filename: file,
  errors: components.map(component => ({ messageId: 'raw', data: { component } })),
});

tester.run('no-raw-admin-joy', rule, {
  valid: [
    valid("import { Box, ModalDialog, CardContent, TableProps } from '@mui/joy';"),
    valid("import { ActionDialog } from './shared/ActionDialog';"),
    valid("import type { Modal } from '@mui/joy';"),
    valid("import { type Card, type Table } from '@mui/joy';"),
    valid("import type { CardProps } from '@mui/joy/Card';"),
    valid("import { type CardProps } from '@mui/joy/Card';"),
    valid("export { type TableProps } from '@mui/joy/Table';"),
    valid("import { cardClasses } from '@mui/joy/Card';"),
    ...[
      'Card/cardClasses',
      'Modal/modalClasses',
      'Table/tableClasses',
      'node/Card/cardClasses.js',
      'modern/Modal/modalClasses.js',
    ].flatMap(source => [
      valid(`import classes from '@mui/joy/${source}';`),
      valid(`import * as helpers from '@mui/joy/${source}';`),
      valid(`export { default as classes } from '@mui/joy/${source}';`),
      valid(`export * from '@mui/joy/${source}';`),
    ]),
    valid(
      "// admin-toolkit-allow 2026-10-27 -- Read-only preview needs a custom focus container\nimport { Modal } from '@mui/joy';"
    ),
    { code: "import { Card, Modal, Table } from '@mui/joy';", filename: path.join(admin, 'shared/nested/Toolkit.tsx') },
    { code: "import { Modal } from '@mui/joy';", filename: path.join(root, 'apps/client/app/components/Other.tsx') },
  ],
  invalid: [
    invalid("import { Modal } from '@mui/joy';"),
    ...['index', 'index.js', 'node', 'node/index', 'node/index.js', 'modern', 'modern/index.js'].flatMap(source => [
      invalid(`import { Modal } from '@mui/joy/${source}';`),
      invalid(`export { Modal as Dialog } from '@mui/joy/${source}';`),
      invalid(`import * as Joy from '@mui/joy/${source}';`, ['*']),
      invalid(`export * from '@mui/joy/${source}';`, ['*']),
    ]),
    ...['Card', 'Modal', 'Table'].flatMap(component =>
      [
        component,
        `${component}/index.js`,
        `${component}/${component}.js`,
        `node/${component}`,
        `node/${component}/${component}.js`,
        `modern/${component}/index.js`,
        `modern/${component}/${component}.js`,
      ].flatMap(source => [
        invalid(`import Raw from '@mui/joy/${source}';`, [component]),
        invalid(`export { default as Raw } from '@mui/joy/${source}';`, [component]),
        invalid(`export * from '@mui/joy/${source}';`, [component]),
      ])
    ),
    invalid("import { Card as Panel, Modal as Dialog, Table as Grid } from '@mui/joy';", ['Card', 'Modal', 'Table']),
    invalid("import Dialog from '@mui/joy/Modal';"),
    invalid("import { default as Panel } from '@mui/joy/Card';", ['Card']),
    invalid("import Grid from '@mui/joy/Table/Table';", ['Table']),
    invalid("import * as Joy from '@mui/joy';", ['*']),
    invalid("import Joy from '@mui/joy';", ['*']),
    invalid("export { Modal as Dialog } from '@mui/joy';"),
    invalid("export { default as Grid } from '@mui/joy/Table';", ['Table']),
    invalid("export * from '@mui/joy';", ['*']),
    invalid("import * as Dialog from '@mui/joy/Modal';"),
    invalid("import { default as First, default as Second } from '@mui/joy/Card';", ['Card', 'Card']),
    invalid("// admin-toolkit-allow -- A reason without a date\nimport { Modal } from '@mui/joy';"),
    invalid("// admin-toolkit-allow 2026-10-27 -- \nimport { Modal } from '@mui/joy';"),
    invalid("// admin-toolkit-allow 2026-10-27 -- Custom focus container\n\nimport { Modal } from '@mui/joy';"),
    invalid("import { Modal } from '@mui/joy';", ['Modal'], path.join(admin, 'AuditLog/shared/NewTab.tsx')),
    invalid("import { Card, Modal } from '@mui/joy';", ['Card', 'Modal']),
    invalid("import { Card, Card as AnotherCard } from '@mui/joy';", ['Card', 'Card']),
  ],
});

describe('repository config', () => {
  const eslint = new ESLint({ cwd: root });

  it('does not transfer a removed Modal exception to a new declaration in the same file', async () => {
    const filePath = path.join(admin, 'AdminProfileModal.tsx');
    const original = readFileSync(filePath, 'utf8');
    const declaration = "import { LinearProgress, Modal, ModalClose, ModalDialog, Stack } from '@mui/joy';";
    for (const code of [
      original.replace(declaration, ''),
      original.replace(declaration, declaration.replace('Modal, ', '')),
      original.replace(declaration, declaration.replace('Modal, ', '')) + "\nimport { Modal } from '@mui/joy';",
      original.replace(declaration, declaration.replace('Modal, ', 'Modal as Dialog, ')),
      '\n' + original,
    ]) {
      const [result] = await eslint.lintText(code, { filePath });
      const messages = result.messages.filter(message => message.ruleId === 'b4m/no-raw-admin-joy');
      expect(messages.some(message => message.messageId === 'stale')).toBe(true);
      if (code.includes('import { Modal }')) expect(messages.some(message => message.messageId === 'raw')).toBe(true);
    }
  });

  it('rejects additional imports while the original legacy declaration remains', async () => {
    const filePath = path.join(admin, 'AdminProfileModal.tsx');
    const code = readFileSync(filePath, 'utf8') + "\nimport { Modal as AnotherDialog } from '@mui/joy';";
    const [result] = await eslint.lintText(code, { filePath });
    expect(result.messages.filter(message => message.ruleId === 'b4m/no-raw-admin-joy').map(m => m.messageId)).toEqual([
      'raw',
    ]);
  });

  it('enables an error on new admin imports but exempts only the root toolkit', async () => {
    const code = "import { Modal as Dialog } from '@mui/joy';\nexport default Dialog;\n";
    for (const [file, count] of [
      ['NewTab.tsx', 1],
      ['AuditLog/shared/NewTab.tsx', 1],
      ['shared/NewDialog.tsx', 0],
    ]) {
      const [result] = await eslint.lintText(code, { filePath: path.join(admin, file) });
      expect(result.messages.filter(message => message.ruleId === 'b4m/no-raw-admin-joy')).toHaveLength(count);
      expect(result.errorCount).toBe(count);
    }
  });

  it('keeps the legacy baseline exact so removed imports cannot leave reusable exemptions', () => {
    expect(Object.keys(imports).sort()).toEqual(Object.keys(legacy).sort());
    for (const [file, { components, date, reason }] of Object.entries(legacy)) {
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(reason).toContain(file);
      const { ast } = tseslint.parser.parseForESLint(readFileSync(path.join(admin, file), 'utf8'), {
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      });
      const actual = ast.body.flatMap(node => {
        if (node.type !== 'ImportDeclaration' || node.importKind === 'type') return [];
        if (/^@mui\/joy\/(Card|Modal|Table)(?:\/|$)/.test(node.source.value)) {
          return [node.source.value.split('/')[2]];
        }
        if (node.source.value !== '@mui/joy') return [];
        return node.specifiers.flatMap(specifier => {
          const name = specifier.imported?.name;
          return specifier.importKind !== 'type' && ['Card', 'Modal', 'Table'].includes(name) ? [name] : [];
        });
      });
      expect(actual.sort(), file).toEqual([...components].sort());
    }
  });

  it('matches every pinned declaration and reports no stale legacy exceptions', async () => {
    const guard = new ESLint({
      cwd: root,
      allowInlineConfig: false,
      overrideConfigFile: true,
      overrideConfig: {
        files: ['**/*.tsx'],
        languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
        plugins: { b4m: { rules: { 'no-raw-admin-joy': rule } } },
        rules: { 'b4m/no-raw-admin-joy': 'error' },
      },
    });
    const results = await guard.lintFiles(Object.keys(imports).map(file => path.join(admin, file)));
    expect(results.flatMap(result => result.messages)).toEqual([]);
  });
});
