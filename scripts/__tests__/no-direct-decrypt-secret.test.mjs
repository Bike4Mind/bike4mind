import { ESLint, RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { afterAll, describe, expect, it } from 'vitest';
import rule from '../../eslint-rules/no-direct-decrypt-secret.mjs';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.afterAll = afterAll;

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });
const invalid = code => ({ code, errors: [{ messageId: 'direct' }] });

tester.run('no-direct-decrypt-secret', rule, {
  valid: [
    "import { decryptToken, decryptStoredSecret } from '@bike4mind/server-utils/security/tokenEncryption';",
    "import { decryptAtRest, encryptSecret, isEncrypted } from '@bike4mind/utils/security';",
    "export { decryptStoredSecret as readSecret } from '@bike4mind/server-utils/security/tokenEncryption';",
    'export function decryptSecret(value: string, key: string): string { return value + key; }',
    'const decryptSecrets = 1;',
    "const name = 'decryptSecret';",
    'const { decryptToken } = await import(modulePath);',
    'const stub = { decryptSecret: () => 1 };',
  ],
  invalid: [
    invalid("import { decryptSecret } from '@bike4mind/server-utils/security/secretEncryption';"),
    invalid("import { encryptSecret, decryptSecret } from '@bike4mind/utils/security';"),
    invalid("import { decryptSecret as open } from './secretEncryption';"),
    invalid("import { 'decryptSecret' as open } from './secretEncryption';"),
    invalid("export { decryptSecret } from '@bike4mind/utils/security';"),
    invalid("export { decryptSecret as readSecret } from '@bike4mind/utils/security';"),
    invalid("export { 'decryptSecret' as readSecret } from '@bike4mind/utils/security';"),
    invalid('const decryptSecret = () => 1; export { decryptSecret as readSecret };'),
    invalid("import * as crypto from './secretEncryption'; crypto.decryptSecret(value, key);"),
    invalid("import * as crypto from './secretEncryption'; crypto['decryptSecret'](value, key);"),
    invalid("const { decryptSecret } = require('./secretEncryption');"),
    invalid("const { decryptSecret: open } = await import('./secretEncryption');"),
  ],
});

// Reads the resolved config instead of linting text, so no file is parsed or type-checked.
describe('no-direct-decrypt-secret wiring', () => {
  const eslint = new ESLint({ cwd: new URL('../..', import.meta.url).pathname });
  const enforced = async filePath => {
    const config = await eslint.calculateConfigForFile(filePath);
    return config?.rules?.['b4m/no-direct-decrypt-secret']?.[0] === 2;
  };

  it.each([
    'apps/client/pages/api/example.ts',
    'apps/client/server/managers/example.ts',
    'apps/workers/src/queueHandlers/example.ts',
    'b4m-core/services/src/example.ts',
    'packages/server-utils/src/services/example.ts',
    'packages/database/src/models/example.ts',
    'packages/scripts/migrate/example.ts',
  ])('is enforced in %s', async filePath => {
    expect(await enforced(filePath)).toBe(true);
  });

  it.each([
    'b4m-core/utils/src/security/secretsAtRest.ts',
    'packages/server-utils/src/security/tokenEncryption.ts',
    'packages/server-utils/src/security/secretEncryption.ts',
    'packages/scripts/migrate/encrypt-admin-settings-and-apikeys.ts',
    'packages/scripts/migrate/encrypt-tokens-at-rest.ts',
    'packages/server-utils/src/services/example.test.ts',
  ])('is not enforced in %s', async filePath => {
    expect(await enforced(filePath)).toBe(false);
  });
});
