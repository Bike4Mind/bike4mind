import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint, RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { afterAll, describe, expect, it } from 'vitest';
import rule from '../../eslint-rules/no-raw-admin-joy.mjs';

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

  it('rejects a raw import added to a toolkit-only admin screen', async () => {
    const filePath = path.join(admin, 'NewTab.tsx');
    const code =
      "import { Stack } from '@mui/joy';\nimport { DataTable } from './shared';\nimport { Modal as Dialog } from '@mui/joy';\nexport { Stack, DataTable, Dialog };\n";
    const [result] = await eslint.lintText(code, { filePath });
    const messages = result.messages.filter(message => message.ruleId === 'b4m/no-raw-admin-joy');
    expect(messages.map(m => [m.messageId, m.line])).toEqual([['raw', 3]]);
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
});
