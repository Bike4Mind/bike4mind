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
