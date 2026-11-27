import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Plugin } from 'vite';

const require = createRequire(import.meta.url);

type ExportSource = { module: string; imported: string };

/**
 * Maps every name a barrel's root re-exports to the subpath module that defines it, by reading
 * the barrel's own `export { default as X } from './X'` / `export * from './X'` lines. A name
 * reached through `export *` is found by loading that subpath once, at config time.
 */
function readBarrelExports(packageName: string): Map<string, ExportSource> {
  const packageRoot = path.dirname(require.resolve(`${packageName}/package.json`));
  const index = readFileSync(path.join(packageRoot, 'index.js'), 'utf8');
  const exports = new Map<string, ExportSource>();

  for (const [, name, subpath] of index.matchAll(/export \{ default as (\w+) \} from '\.\/(\w+)';/g)) {
    exports.set(name, { module: `${packageName}/${subpath}`, imported: 'default' });
  }
  for (const [, subpath] of index.matchAll(/export \* from '\.\/(\w+)';/g)) {
    const subpathModule = `${packageName}/${subpath}`;
    for (const name of Object.keys(require(subpathModule) as Record<string, unknown>)) {
      if (name === 'default' || name === '__esModule' || exports.has(name)) continue;
      exports.set(name, { module: subpathModule, imported: name });
    }
  }
  if (exports.size === 0) throw new Error(`[barrelImports] found no re-exports in ${packageName}/index.js`);
  return exports;
}

/**
 * Rewrites `import { A, B as C } from '<barrel>'` in source files into one import per subpath
 * module, so a test loads only the components it uses rather than the whole library.
 */
export function rewriteBarrelImports(code: string, packageName: string, exports: Map<string, ExportSource>): string {
  const escaped = packageName.replace(/[/@]/g, '\\$&');
  const statement = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*["']${escaped}["'];?`, 'g');

  return code.replace(statement, (whole, specifierList: string) => {
    const imports: string[] = [];
    for (const specifier of specifierList
      .split(',')
      .map(part => part.trim())
      .filter(Boolean)) {
      const match = /^(\w+)(?:\s+as\s+(\w+))?$/.exec(specifier);
      const source = match && exports.get(match[1]);
      // Anything unrecognised keeps the original barrel import: slower, never wrong.
      if (!match || !source) return whole;
      const local = match[2] ?? match[1];
      imports.push(
        source.imported === 'default'
          ? `import ${local} from '${source.module}';`
          : `import { ${source.imported === local ? local : `${source.imported} as ${local}`} } from '${source.module}';`
      );
    }
    // Same line count as the statement it replaces, so later line numbers in stack traces hold.
    const newlines = whole.split('\n').length - 1;
    return imports.join(' ') + '\n'.repeat(newlines);
  });
}

export function barrelImportsPlugin(packageNames: string[]): Plugin {
  const barrels = packageNames.map(name => ({ name, exports: readBarrelExports(name) }));
  return {
    name: 'b4m:barrel-imports',
    enforce: 'post',
    transform(code, id) {
      if (id.includes('/node_modules/')) return null;
      let result = code;
      for (const barrel of barrels) {
        if (result.includes(barrel.name)) result = rewriteBarrelImports(result, barrel.name, barrel.exports);
      }
      return result === code ? null : { code: result, map: null };
    },
  };
}
