import { describe, it, expect, beforeAll } from 'vitest';
import { ESLint } from 'eslint';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Three levels up: __tests__ → codemods → scripts → monorepo root
const ROOT = path.resolve(__dirname, '../../..');

describe('B4Mv3 ESLint import guards', () => {
  let eslint: ESLint;

  beforeAll(() => {
    eslint = new ESLint({ cwd: ROOT });
  });

  async function lint(code: string, relativeFilePath: string) {
    const results = await eslint.lintText(code, {
      filePath: path.join(ROOT, relativeFilePath),
    });
    return results[0].messages;
  }

  type LintMessage = Awaited<ReturnType<ESLint['lintText']>>[number]['messages'][number];

  function hasB4Mv3Error(messages: LintMessage[]) {
    return messages.some(m => m.ruleId === 'no-restricted-imports' && m.severity === 2);
  }

  it('flags @bike4mind/utils Logger import in b4m-core/agents (direct B4Mv3 block)', async () => {
    const messages = await lint(`import { Logger } from '@bike4mind/utils';`, 'b4m-core/agents/src/example.ts');
    expect(hasB4Mv3Error(messages)).toBe(true);
  });

  it('flags @bike4mind/utils Logger import in packages/database (direct B4Mv3 block)', async () => {
    const messages = await lint(`import { Logger } from '@bike4mind/utils';`, 'packages/database/src/example.ts');
    expect(hasB4Mv3Error(messages)).toBe(true);
  });

  it('flags @bike4mind/utils Logger import in apps/client/app (via Next.js block)', async () => {
    const messages = await lint(`import { Logger } from '@bike4mind/utils';`, 'apps/client/app/components/example.tsx');
    expect(hasB4Mv3Error(messages)).toBe(true);
  });

  it('flags @bike4mind/utils Logger import in apps/client/server (via Overwatch block)', async () => {
    const messages = await lint(`import { Logger } from '@bike4mind/utils';`, 'apps/client/server/services/example.ts');
    expect(hasB4Mv3Error(messages)).toBe(true);
  });

  it('does not flag @bike4mind/utils import in b4m-core/utils (source package is excluded)', async () => {
    const messages = await lint(`import { Logger } from '@bike4mind/utils';`, 'b4m-core/utils/src/index.ts');
    const b4mv3Errors = messages.filter(m => m.ruleId === 'no-restricted-imports' && m.severity === 2);
    expect(b4mv3Errors).toHaveLength(0);
  });

  it('flags @bike4mind/services AuthTokenGeneratorService in apps/client/server (via Overwatch block)', async () => {
    const messages = await lint(
      `import { AuthTokenGeneratorService } from '@bike4mind/services';`,
      'apps/client/server/services/example.ts'
    );
    expect(hasB4Mv3Error(messages)).toBe(true);
  });

  // B4Mv3 #8808 — @bike4mind/database/src deep-import ban (added to b4mv3RestrictedPatterns)
  it('flags @bike4mind/database/src deep import in b4m-core/agents (main b4mv3 block)', async () => {
    const messages = await lint(
      `import { ISession } from '@bike4mind/database/src/models/SessionModel';`,
      'b4m-core/agents/src/example.ts'
    );
    expect(hasB4Mv3Error(messages)).toBe(true);
  });

  it('flags @bike4mind/database/src deep import in apps/client/app (via Next.js block)', async () => {
    const messages = await lint(
      `import { IQuest } from '@bike4mind/database/src/models/QuestModel';`,
      'apps/client/app/components/example.tsx'
    );
    expect(hasB4Mv3Error(messages)).toBe(true);
  });

  it('flags @bike4mind/database/src deep import in apps/client/server (via Overwatch block)', async () => {
    const messages = await lint(
      `import { IUser } from '@bike4mind/database/src/models/UserModel';`,
      'apps/client/server/services/example.ts'
    );
    expect(hasB4Mv3Error(messages)).toBe(true);
  });

  // b4m-core/common has a broader ban — entire @bike4mind/database package is restricted,
  // not just deep /src paths. This test guards against that ban being silently relaxed.
  it('flags root @bike4mind/database import in b4m-core/common (full-package ban)', async () => {
    const messages = await lint(`import { ISession } from '@bike4mind/database';`, 'b4m-core/common/src/example.ts');
    expect(messages.some(m => m.ruleId === 'no-restricted-imports' && m.severity === 2)).toBe(true);
  });
});

describe('apps/workers <-> apps/client import boundary', () => {
  let eslint: ESLint;

  beforeAll(() => {
    eslint = new ESLint({ cwd: ROOT });
  });

  async function lint(code: string, relativeFilePath: string) {
    const results = await eslint.lintText(code, {
      filePath: path.join(ROOT, relativeFilePath),
    });
    return results[0].messages;
  }

  function hasRestrictedImportError(messages: Awaited<ReturnType<typeof lint>>) {
    return messages.some(m => m.ruleId === 'no-restricted-imports' && m.severity === 2);
  }

  it('flags apps/client importing from apps/workers via the @workers/* alias', async () => {
    const messages = await lint(`import x from '@workers/events/spider';`, 'apps/client/server/foo.ts');
    expect(hasRestrictedImportError(messages)).toBe(true);
  });

  it('flags apps/client/app (the Next.js block) importing from apps/workers', async () => {
    const messages = await lint(`import x from '@workers/events/spider';`, 'apps/client/app/foo.tsx');
    expect(hasRestrictedImportError(messages)).toBe(true);
  });

  it('flags apps/client reaching into apps/workers by a relative path', async () => {
    const messages = await lint(
      `import x from '../../../workers/src/events/spider';`,
      'apps/client/server/utils/foo.ts'
    );
    expect(hasRestrictedImportError(messages)).toBe(true);
  });

  it.each(['@client/app/components/Foo', '@/app/components/Foo', '@pages/api/foo'])(
    'flags apps/workers importing client UI or route code via %s',
    async specifier => {
      const messages = await lint(`import x from '${specifier}';`, 'apps/workers/src/events/foo.ts');
      expect(hasRestrictedImportError(messages)).toBe(true);
    }
  );

  it('flags apps/workers importing UI code (react)', async () => {
    const messages = await lint(`import { useState } from 'react';`, 'apps/workers/src/events/foo.ts');
    expect(hasRestrictedImportError(messages)).toBe(true);
  });

  it('does not flag apps/workers importing apps/client/server code via the @server/* bridge', async () => {
    const messages = await lint(`import { Config } from '@server/utils/config';`, 'apps/workers/src/events/foo.ts');
    expect(hasRestrictedImportError(messages)).toBe(false);
  });

  // Proves the apps/workers block's no-restricted-imports options (paths + patterns) were merged
  // onto the pre-existing Overwatch/B4Mv3 restrictions rather than replacing them - flat-config
  // no-restricted-imports is last-rule-wins per file, so a careless merge would silently drop this.
  it('still flags apps/workers reaching into Overwatch internals (pre-existing Overwatch barrier)', async () => {
    const messages = await lint(`import x from '@server/overwatch/services/foo';`, 'apps/workers/src/events/foo.ts');
    expect(hasRestrictedImportError(messages)).toBe(true);
  });
});

describe('CI gate backstop — error-severity rules that must stay at error', () => {
  let eslint: ESLint;

  beforeAll(() => {
    eslint = new ESLint({ cwd: ROOT });
  });

  async function lint(code: string, relativeFilePath: string) {
    const results = await eslint.lintText(code, {
      filePath: path.join(ROOT, relativeFilePath),
    });
    return results[0].messages;
  }

  it('no-case-declarations fires at error severity on bare const in switch case', async () => {
    const code = `
      function f(x: string) {
        switch (x) {
          case 'a':
            const y = 1;
            break;
        }
      }
    `;
    const messages = await lint(code, 'apps/client/app/utils/example.ts');
    expect(messages.some(m => m.ruleId === 'no-case-declarations' && m.severity === 2)).toBe(true);
  });

  it('react-hooks/rules-of-hooks fires at error severity on conditional hook call', async () => {
    const code = `
      import { useState } from 'react';
      function MyComponent({ show }: { show: boolean }) {
        if (show) {
          const [v, setV] = useState(0);
        }
        return null;
      }
    `;
    const messages = await lint(code, 'apps/client/app/components/example.tsx');
    expect(messages.some(m => m.ruleId === 'react-hooks/rules-of-hooks' && m.severity === 2)).toBe(true);
  });

  it('react-hooks/immutability fires at error severity on property assignment to state variable', async () => {
    const code = `
      import { useState } from 'react';
      function MyComponent() {
        const [el, setEl] = useState<{ value: number } | null>(null);
        if (el) { el.value = 1; }
        return null;
      }
    `;
    const messages = await lint(code, 'apps/client/app/components/example.tsx');
    expect(messages.some(m => m.ruleId === 'react-hooks/immutability' && m.severity === 2)).toBe(true);
  });

  it('react-hooks/preserve-manual-memoization fires at error severity on property-access deps that mask the parent', async () => {
    const code = `
      import React, { useCallback } from 'react';
      interface User { id: string }
      export function MyComponent({ user, onPublish }: { user: User | null; onPublish: (id: string) => void }) {
        const handle = useCallback(
          () => {
            if (!user?.id) return;
            onPublish(String(user.id));
          },
          [user?.id, onPublish]
        );
        return <button onClick={handle}>go</button>;
      }
    `;
    const messages = await lint(code, 'apps/client/app/components/example.tsx');
    expect(messages.some(m => m.ruleId === 'react-hooks/preserve-manual-memoization' && m.severity === 2)).toBe(true);
  });

  it('react-hooks/error-boundaries fires at error severity on JSX returned from a catch block', async () => {
    const code = `
      import React from 'react';
      export function MyComponent({ data }: { data: string }) {
        try {
          const parsed = JSON.parse(data);
          return <div>{parsed.label}</div>;
        } catch {
          return <div>Error</div>;
        }
      }
    `;
    const messages = await lint(code, 'apps/client/app/components/example.tsx');
    expect(messages.some(m => m.ruleId === 'react-hooks/error-boundaries' && m.severity === 2)).toBe(true);
  });
});
