import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint, RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { afterAll, describe, expect, it } from 'vitest';
import rule from '../../eslint-rules/no-raw-admin-joy.mjs';
import legacy from '../../eslint-rules/admin-joy-legacy.mjs';

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
    valid(
      "// admin-toolkit-allow 2026-10-27 -- Read-only preview needs a custom focus container\nimport { Modal } from '@mui/joy';"
    ),
    { code: "import { Card, Modal, Table } from '@mui/joy';", filename: path.join(admin, 'shared/nested/Toolkit.tsx') },
    { code: "import { Modal } from '@mui/joy';", filename: path.join(root, 'apps/client/app/components/Other.tsx') },
    { code: "import { Card } from '@mui/joy';", filename: path.join(admin, 'AdminDashboardTab.tsx') },
  ],
  invalid: [
    invalid("import { Modal } from '@mui/joy';"),
    invalid("import { Card as Panel, Modal as Dialog, Table as Grid } from '@mui/joy';", ['Card', 'Modal', 'Table']),
    invalid("import Dialog from '@mui/joy/Modal';"),
    invalid("import { default as Panel } from '@mui/joy/Card';", ['Card']),
    invalid("import Grid from '@mui/joy/Table/Table';", ['Table']),
    invalid("import * as Joy from '@mui/joy';", ['*']),
    invalid("import Joy from '@mui/joy';", ['*']),
    invalid("export { Modal as Dialog } from '@mui/joy';"),
    invalid("export { default as Grid } from '@mui/joy/Table';", ['Table']),
    invalid("export * from '@mui/joy';", ['*']),
    invalid("// admin-toolkit-allow -- A reason without a date\nimport { Modal } from '@mui/joy';"),
    invalid("// admin-toolkit-allow 2026-10-27 -- \nimport { Modal } from '@mui/joy';"),
    invalid("// admin-toolkit-allow 2026-10-27 -- Custom focus container\n\nimport { Modal } from '@mui/joy';"),
    invalid("import { Modal } from '@mui/joy';", ['Modal'], path.join(admin, 'AuditLog/shared/NewTab.tsx')),
    invalid("import { Card, Modal } from '@mui/joy';", ['Modal'], path.join(admin, 'AdminDashboardTab.tsx')),
    invalid(
      "import { Card, Card as AnotherCard } from '@mui/joy';",
      ['Card'],
      path.join(admin, 'AdminDashboardTab.tsx')
    ),
  ],
});

describe('repository config', () => {
  const eslint = new ESLint({ cwd: root });

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
    for (const [file, components] of Object.entries(legacy)) {
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
});
