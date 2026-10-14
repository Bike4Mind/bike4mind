import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rewriteSource, run, toMove } from '../move-to-server-utils';

const MOVES = [
  toMove('apps/client/server/memory/factCipher.ts'),
  toMove('apps/client/server/memory/factCipher.test.ts'),
  toMove('apps/client/server/utils/sessionOperations.ts'),
  toMove('apps/client/server/security/index.ts'),
];

const rewrite = (source: string, file: string, warnings?: string[]) => rewriteSource(source, file, MOVES, warnings);

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
      ["jest.mock('@server/memory/factCipher');", "jest.mock('@bike4mind/server-utils/memory/factCipher');"],
      [
        "const p = require.resolve('@server/memory/factCipher');",
        "const p = require.resolve('@bike4mind/server-utils/memory/factCipher');",
      ],
      [
        'const m = await import(`@server/memory/factCipher`);',
        'const m = await import(`@bike4mind/server-utils/memory/factCipher`);',
      ],
      [
        "import { a } from '@server/memory/factCipher.js';",
        "import { a } from '@bike4mind/server-utils/memory/factCipher';",
      ],
      [
        "import { a } from '../../../client/server/memory/factCipher.ts';",
        "import { a } from '@bike4mind/server-utils/memory/factCipher';",
      ],
      // A directory import resolves through its index file; the exports map needs it spelled out.
      ["import { s } from '@server/security';", "import { s } from '@bike4mind/server-utils/security/index';"],
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

    it('leaves comments and ordinary strings that look like specifiers alone', () => {
      const input = [
        "// moved from '@server/memory/factCipher'",
        "/* import { a } from './factCipher'; */",
        "const s = '@server/memory/factCipher';",
        'log("from \'./factCipher\'");',
      ].join('\n');
      expect(rewrite(input, 'apps/client/server/memory/x.ts')).toBe(input);
    });

    it('leaves an unresolvable template specifier alone and warns when its head points into a moved dir', () => {
      const warnings: string[] = [];
      const input = 'const m = await import(`@server/memory/${name}`);';
      expect(rewrite(input, FILE, warnings)).toBe(input);
      expect(warnings).toEqual([
        `${FILE}: dynamic specifier starting '@server/memory/' may point at a moved file; update by hand`,
      ]);

      const quiet: string[] = [];
      rewrite('const m = await import(`@server/websocket/${name}`);', FILE, quiet);
      expect(quiet).toEqual([]);
    });

    it('leaves a package self-reference alone outside the package', () => {
      const input = "import { a } from '@bike4mind/server-utils/memory/factCipher';";
      expect(rewrite(input, FILE)).toBe(input);
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

    it.each([
      [
        "import { m } from '@pages/api/admin/event-metrics';",
        /stays in apps\/client\/pages\/api\/admin\/event-metrics/,
      ],
      ["import logo from '@public/logo';", /stays in apps\/client\/public\/logo/],
      ["import { h } from '@workers/queueHandlers/foo';", /stays in apps\/workers\/src\/queueHandlers\/foo/],
    ])('throws when a moved file imports %s', (input, message) => {
      expect(() => rewrite(input, 'packages/server-utils/src/memory/factCipher.ts')).toThrow(message);
    });

    it('turns a package self-reference into a relative path', () => {
      expect(
        rewrite(
          "import { a } from '@bike4mind/server-utils/utils/sessionOperations';",
          'packages/server-utils/src/memory/factCipher.ts'
        )
      ).toBe("import { a } from '../utils/sessionOperations';");
      // Also for a package file that was not part of this run's moves.
      expect(
        rewrite(
          "import { a } from '@bike4mind/server-utils/memory/factCipher';",
          'packages/server-utils/src/memory/other.ts'
        )
      ).toBe("import { a } from './factCipher';");
    });
  });

  it('rejects a path outside apps/client/server', () => {
    expect(() => toMove('apps/workers/src/foo.ts')).toThrow(/Not a source file under apps\/client\/server/);
  });

  it.each(['chatCompletion/selfhostSstAlias.mjs', 'memory/foo.tsx', 'memory/foo.mts', 'memory/types.d.ts'])(
    'rejects moving the non-.ts file %s',
    tail => {
      expect(() => toMove(`apps/client/server/${tail}`)).toThrow(/Only \.ts files can be moved/);
    }
  );

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

    it('rewrites the scanned roots, skips node_modules, and is idempotent', () => {
      write('b4m-core/slack/src/d.test.ts', "vi.mock('@server/memory/factCipher');\n");
      write('infra/__tests__/e.test.ts', "import { x } from '../../apps/client/server/memory/factCipher';\n");

      const { changed, warnings } = run(root, ['apps/client/server/memory/factCipher.ts']);
      expect(changed.sort()).toEqual([
        'apps/client/server/memory/b.test.ts',
        'apps/workers/src/a.ts',
        'b4m-core/slack/src/d.test.ts',
        'infra/__tests__/e.test.ts',
      ]);
      expect(warnings).toEqual([]);
      expect(read('apps/workers/src/a.ts')).toBe("import { x } from '@bike4mind/server-utils/memory/factCipher';\n");
      expect(read('infra/__tests__/e.test.ts')).toBe(
        "import { x } from '@bike4mind/server-utils/memory/factCipher';\n"
      );
      expect(read('apps/client/node_modules/pkg/c.ts')).toBe("import '@server/memory/factCipher';\n");
      expect(run(root, ['apps/client/server/memory/factCipher.ts'])).toEqual({ changed: [], warnings: [] });
    });

    it('warns about an overlay importer instead of rewriting it', () => {
      const overlay = 'packages/premium/optihashi/server/f.ts';
      write(overlay, "import { x } from '@server/memory/factCipher';\n");

      const { changed, warnings } = run(root, ['apps/client/server/memory/factCipher.ts']);
      expect(changed).not.toContain(overlay);
      expect(warnings).toEqual([
        `${overlay}: '@server/memory/factCipher' points at a moved file; overlays are separate repos - update by hand`,
      ]);
      expect(read(overlay)).toBe("import { x } from '@server/memory/factCipher';\n");
    });

    it('refuses to run before the file has been moved', () => {
      expect(() => run(root, ['apps/client/server/utils/sessionOperations.ts'])).toThrow(/git mv the file there/);
    });
  });
});
