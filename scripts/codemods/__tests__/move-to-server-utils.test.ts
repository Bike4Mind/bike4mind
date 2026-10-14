import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rewriteSource, run, toMove } from '../move-to-server-utils';

const MOVES = [
  toMove('apps/client/server/memory/factCipher.ts'),
  toMove('apps/client/server/memory/factCipher.test.ts'),
  toMove('apps/client/server/utils/sessionOperations.ts'),
];

const rewrite = (source: string, file: string) => rewriteSource(source, file, MOVES);

describe('move-to-server-utils', () => {
  describe('an importer left in an app', () => {
    const FILE = 'apps/workers/src/queueHandlers/foo.ts';

    it.each([
      [
        "import { a } from '@server/memory/factCipher';",
        "import { a } from '@bike4mind/server-utils/memory/factCipher';",
      ],
      [
        "import type { A } from '@server/memory/factCipher';",
        "import type { A } from '@bike4mind/server-utils/memory/factCipher';",
      ],
      ["export * from '@server/memory/factCipher';", "export * from '@bike4mind/server-utils/memory/factCipher';"],
      ["import '@server/memory/factCipher';", "import '@bike4mind/server-utils/memory/factCipher';"],
      [
        "const m = await import('@server/memory/factCipher');",
        "const m = await import('@bike4mind/server-utils/memory/factCipher');",
      ],
      [
        'const m = require("@server/memory/factCipher");',
        'const m = require("@bike4mind/server-utils/memory/factCipher");',
      ],
      [
        "import { a } from '@client/server/memory/factCipher';",
        "import { a } from '@bike4mind/server-utils/memory/factCipher';",
      ],
      [
        "import { a } from '@/server/memory/factCipher';",
        "import { a } from '@bike4mind/server-utils/memory/factCipher';",
      ],
      [
        "import { a } from '../../../client/server/memory/factCipher';",
        "import { a } from '@bike4mind/server-utils/memory/factCipher';",
      ],
      [
        "vi.mock('@server/memory/factCipher', () => ({}));",
        "vi.mock('@bike4mind/server-utils/memory/factCipher', () => ({}));",
      ],
      ["vi.doMock('@server/memory/factCipher');", "vi.doMock('@bike4mind/server-utils/memory/factCipher');"],
    ])('rewrites %s', (input, expected) => {
      expect(rewrite(input, FILE)).toBe(expected);
    });

    it('rewrites a multi-line vi.importActual behind a generic, including the typeof import()', () => {
      const input = [
        "vi.mock('@server/memory/factCipher', async () => {",
        "  const actual = await vi.importActual<typeof import('@server/memory/factCipher')>(",
        "    '@server/memory/factCipher'",
        '  );',
        '  return actual;',
        '});',
      ].join('\n');
      expect(rewrite(input, FILE)).toBe(input.replaceAll('@server/memory/', '@bike4mind/server-utils/memory/'));
    });

    it('rewrites a relative specifier from a client file that stayed put', () => {
      const input = "vi.mock('./factCipher', () => ({}));";
      expect(rewrite(input, 'apps/client/server/memory/recall.test.ts')).toBe(
        "vi.mock('@bike4mind/server-utils/memory/factCipher', () => ({}));"
      );
    });

    it('leaves specifiers that do not resolve to a moved file alone', () => {
      const input = [
        "import { b } from '@server/memory/other';",
        "import { c } from '@bike4mind/common';",
        "import { d } from './factCipherHelpers';",
        "import { e } from '@server/memory/factCipher/nested';",
      ].join('\n');
      expect(rewrite(input, 'apps/client/server/memory/x.ts')).toBe(input);
    });
  });

  describe('a file inside the package', () => {
    it('rewrites to a relative path from a moved file, resolving from its old location', () => {
      // At its old location this imported a sibling that moved with it into a different directory.
      const input = "import { a } from '../utils/sessionOperations';";
      expect(rewrite(input, 'packages/server-utils/src/memory/factCipher.ts')).toBe(
        "import { a } from '../utils/sessionOperations';"
      );
      expect(
        rewrite(
          "import { a } from '@server/utils/sessionOperations';",
          'packages/server-utils/src/memory/factCipher.ts'
        )
      ).toBe("import { a } from '../utils/sessionOperations';");
    });

    it('keeps a colocated test pointing at its moved source', () => {
      expect(rewrite("import { a } from './factCipher';", 'packages/server-utils/src/memory/factCipher.test.ts')).toBe(
        "import { a } from './factCipher';"
      );
    });

    it('throws when a moved file imports a file left behind in apps/', () => {
      expect(() =>
        rewrite("import { Config } from '../utils/config';", 'packages/server-utils/src/memory/factCipher.ts')
      ).toThrow(/stays in apps\/client\/server\/utils\/config/);
      expect(() =>
        rewrite("import { Config } from '@server/utils/config';", 'packages/server-utils/src/memory/factCipher.ts')
      ).toThrow(/must not import from the apps/);
    });
  });

  it('rejects a path outside apps/client/server', () => {
    expect(() => toMove('apps/workers/src/foo.ts')).toThrow(/Not a source file under apps\/client\/server/);
  });

  describe('run()', () => {
    let root: string;
    const write = (rel: string, text: string) => {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), text);
    };
    const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

    beforeEach(() => {
      root = mkdtempSync(path.join(tmpdir(), 'move-to-server-utils-'));
      write('packages/server-utils/src/memory/factCipher.ts', "import type { P } from '@bike4mind/memory';\n");
      write('apps/workers/src/a.ts', "import { x } from '@server/memory/factCipher';\n");
      write('apps/client/server/memory/b.test.ts', "vi.mock('./factCipher');\n");
      write('apps/client/node_modules/pkg/c.ts', "import '@server/memory/factCipher';\n");
    });

    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it('rewrites the scanned apps, skips node_modules, and is idempotent', () => {
      const changed = run(root, ['apps/client/server/memory/factCipher.ts']);
      expect(changed.sort()).toEqual(['apps/client/server/memory/b.test.ts', 'apps/workers/src/a.ts']);
      expect(read('apps/workers/src/a.ts')).toBe("import { x } from '@bike4mind/server-utils/memory/factCipher';\n");
      expect(read('apps/client/node_modules/pkg/c.ts')).toBe("import '@server/memory/factCipher';\n");
      expect(run(root, ['apps/client/server/memory/factCipher.ts'])).toEqual([]);
    });

    it('refuses to run before the file has been moved', () => {
      expect(() => run(root, ['apps/client/server/utils/sessionOperations.ts'])).toThrow(/git mv the file there/);
    });
  });
});
