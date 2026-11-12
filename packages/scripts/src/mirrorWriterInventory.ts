import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { ROOT } from './apiRouteSources';

const DIRECT_WRITE_METHODS = new Set([
  'bulkWrite',
  'bulkSave',
  'insertOne',
  'insertMany',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'findByIdAndUpdate',
  'findByIdAndDelete',
  'save',
  'create',
  'remove',
  'drop',
  'dropDatabase',
]);
const DIRECT_WRITE_DIRS = ['apps/client', 'apps/workers/src', 'packages/scripts'];
const WRITE_TOKEN =
  /\.(?:bulkWrite|bulkSave|insertOne|insertMany|updateOne|updateMany|replaceOne|deleteOne|deleteMany|findOneAndUpdate|findOneAndDelete|findOneAndReplace|findByIdAndUpdate|findByIdAndDelete|save|create|remove|drop|dropDatabase)\s*\(/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage', 'premium-generated']);

function sourceFiles(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(entry => {
    const file = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : sourceFiles(file);
    return entry.isFile() && /\.(ts|tsx)$/.test(file) && !/\.(test|spec)\.(ts|tsx)$/.test(file) ? [file] : [];
  });
}

export type DirectWrite = { file: string; line: number; method: string };

export function directWritesInSource(file: string, text: string): DirectWrite[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const writes: DirectWrite[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      DIRECT_WRITE_METHODS.has(node.expression.name.text)
    ) {
      writes.push({
        file,
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        method: node.expression.name.text,
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return writes;
}

export function inventoryDirectWrites(): DirectWrite[] {
  return DIRECT_WRITE_DIRS.flatMap(dir =>
    sourceFiles(dir).flatMap(file => {
      const text = readFileSync(path.join(ROOT, file), 'utf8');
      return WRITE_TOKEN.test(text) ? directWritesInSource(file, text) : [];
    })
  );
}

export function mirrorWriterFailures(writes: readonly DirectWrite[], includedWritersInstrumented: boolean): string[] {
  if (!includedWritersInstrumented) return [`${writes.length} direct write calls require owner/outbox coverage review`];
  // A positive assertion needs a reviewed, per-writer mapping, not a boolean over a source scan.
  return writes.map(write => `${write.file}:${write.line} ${write.method} has no verified outbox mapping`);
}
