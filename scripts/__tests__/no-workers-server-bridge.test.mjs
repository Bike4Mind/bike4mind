import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { afterAll, describe, it } from 'vitest';
import rule from '../../eslint-rules/no-workers-server-bridge.mjs';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.afterAll = afterAll;

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });
const invalid = (code, specifier = '@server/a') => ({ code, errors: [{ messageId: 'bridge', data: { specifier } }] });

tester.run('no-workers-server-bridge', rule, {
  valid: [
    "import { a } from '@bike4mind/server-utils/a';",
    "import a from '@serverless/a';",
    "import a from '@servers/a';",
    "import a from './server/a';",
    "export { a } from '@bike4mind/server-utils';",
    'export const a = 1;',
    "vi.mock('./a');",
    "foo.mock('@server/a');",
    "vi['mock']('@server/a');",
    "jest.mock('@server/a');",
    'await import(dynamicPath);',
    'await import(`@server/${name}`);',
    "type A = typeof import('@bike4mind/server-utils');",
    "const a = require('./a');",
    "requireLike('@server/a');",
    "const s = '@server/a';",
  ],
  invalid: [
    invalid("import { a } from '@server/a';"),
    invalid("import type { A } from '@server/a';"),
    invalid("import '@server/a';"),
    invalid("export { a } from '@server/a';"),
    invalid("export type { A } from '@server/a';"),
    invalid("export * from '@server/a';"),
    invalid("const m = await import('@server/a');"),
    invalid('const m = await import(`@server/a`);'),
    invalid("type A = typeof import('@server/a');"),
    invalid("type A = import('@server/a').A;"),
    invalid("const a = require('@server/a');"),
    invalid("import a = require('@server/a');"),
    invalid("vi.mock('@server/a', () => ({}));"),
    invalid("vi.doMock('@server/a');"),
    invalid("vi.unmock('@server/a');"),
    invalid("vi.doUnmock('@server/a');"),
    invalid("const a = await vi.importActual('@server/a');"),
    invalid("const a = await vi.importMock('@server/a');"),
    invalid("vi.mock(import('@server/a'));"),
    invalid("import a from '@server';", '@server'),
    {
      code: "import { a } from '@server/a';\nvi.mock('@server/b/c');",
      errors: [
        { messageId: 'bridge', data: { specifier: '@server/a' } },
        { messageId: 'bridge', data: { specifier: '@server/b/c' } },
      ],
    },
  ],
});
