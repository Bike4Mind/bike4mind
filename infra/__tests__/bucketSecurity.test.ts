/**
 * @vitest-environment node
 *
 * Structural guard: every `new sst.aws.Bucket` in infra/ must pass the shared BLOCK_ALL_PUBLIC_ACCESS as
 * `transform.publicAccessBlock`, be followed by `encryptBucketAtRest(<name>, <bucketVar>)`, and not be public.
 * Files are parsed (not imported) because infra/ uses SST globals at module scope. Only `sst.aws.Bucket` is
 * matched; a raw `aws.s3.BucketV2` would escape the guard.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ts from 'typescript';

const INFRA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const unwrap = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)
    ? unwrap(node.expression)
    : node;

const prop = (obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined => {
  for (const p of obj.properties) {
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return p.name;
    if (ts.isPropertyAssignment(p) && p.name.getText() === name) return unwrap(p.initializer);
  }
  return undefined;
};

const calleeIs = (node: ts.CallExpression | ts.NewExpression, text: string) => node.expression.getText() === text;

const analyze = (src: string) => {
  const sf = ts.createSourceFile('infra.ts', src, ts.ScriptTarget.Latest, true);
  const buckets: { name: string; args: ts.Expression | undefined }[] = [];
  const encrypted = new Set<string>();
  let unattributed = 0;

  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && calleeIs(node, 'sst.aws.Bucket')) {
      if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
        buckets.push({ name: node.parent.name.text, args: node.arguments?.[1] && unwrap(node.arguments[1]) });
      } else {
        unattributed++;
      }
    }
    if (ts.isCallExpression(node) && calleeIs(node, 'encryptBucketAtRest')) {
      const [nameArg, bucketArg] = node.arguments;
      if (nameArg && ts.isStringLiteralLike(nameArg) && bucketArg && ts.isIdentifier(bucketArg)) {
        encrypted.add(bucketArg.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  const problem = (b: { name: string; args: ts.Expression | undefined }): string | null => {
    if (!b.args || !ts.isObjectLiteralExpression(b.args) || b.args.properties.some(ts.isSpreadAssignment)) {
      return `${b.name} args must be an object literal without spread`;
    }
    const access = prop(b.args, 'access');
    const pub = prop(b.args, 'public');
    if (
      (access && ts.isStringLiteralLike(access) && access.text === 'public') ||
      pub?.kind === ts.SyntaxKind.TrueKeyword
    ) {
      return `${b.name} must not be public`;
    }
    const transform = prop(b.args, 'transform');
    const pab = transform && ts.isObjectLiteralExpression(transform) ? prop(transform, 'publicAccessBlock') : undefined;
    if (!pab || !ts.isIdentifier(pab) || pab.text !== 'BLOCK_ALL_PUBLIC_ACCESS') {
      return `${b.name} must set transform.publicAccessBlock to BLOCK_ALL_PUBLIC_ACCESS`;
    }
    if (!encrypted.has(b.name)) return `${b.name} has no encryptBucketAtRest call`;
    return null;
  };

  return { buckets, unattributed, problems: () => buckets.map(problem).filter((p): p is string => p !== null) };
};

const found = readdirSync(INFRA_DIR, { recursive: true, encoding: 'utf8' })
  .filter(f => f.endsWith('.ts') && !f.split(path.sep).includes('__tests__'))
  .map(f => ({ file: f, ...analyze(readFileSync(path.join(INFRA_DIR, f), 'utf8')) }));
const all = found.flatMap(f => f.buckets);

describe('S3 buckets state encryption and public-access blocking', () => {
  it('finds every bucket (guards the guard)', () => {
    expect(all.map(b => b.name).sort()).toEqual(
      [
        'appFilesBucket',
        'emailIngestionBucket',
        'fabFileBucket',
        'generatedImagesBucket',
        'historyImportBucket',
        'publishedArtifactsBucket',
        'qaArtifactsBucket',
        'slackExportBucket',
      ].sort()
    );
  });

  it('attributes every `new sst.aws.Bucket(` to a variable declaration', () => {
    expect(found.filter(f => f.unattributed !== 0).map(f => f.file)).toEqual([]);
  });

  it('passes on every bucket in infra/', () => {
    expect(found.flatMap(f => f.problems())).toEqual([]);
  });

  it('shared definition sets all four flags and AES256', () => {
    const src = readFileSync(path.join(INFRA_DIR, 'bucketSecurity.ts'), 'utf8');
    for (const flag of ['blockPublicAcls', 'blockPublicPolicy', 'ignorePublicAcls', 'restrictPublicBuckets']) {
      expect(src).toMatch(new RegExp(`${flag}: true`));
    }
    expect(src).toContain("sseAlgorithm: 'AES256'");
  });
});

describe('guard parsing', () => {
  const pab = `transform: { publicAccessBlock: BLOCK_ALL_PUBLIC_ACCESS }`;
  const good = `const b = new sst.aws.Bucket('b', { ${pab} });\nencryptBucketAtRest('b', b);`;

  it('accepts a secured bucket', () => {
    expect(analyze(good).problems()).toEqual([]);
  });

  it('reports a bucket without the BPA transform', () => {
    const src = `const b = new sst.aws.Bucket('b', {});\nencryptBucketAtRest('b', b);`;
    expect(analyze(src).problems()).toEqual(['b must set transform.publicAccessBlock to BLOCK_ALL_PUBLIC_ACCESS']);
  });

  it('reports a bucket without an encrypt call, or encrypted under another variable', () => {
    const noCall = `const b = new sst.aws.Bucket('b', { ${pab} });`;
    expect(analyze(noCall).problems()).toEqual(['b has no encryptBucketAtRest call']);
    const other = `const b = new sst.aws.Bucket('b', { ${pab} });\nconst c = new sst.aws.Bucket('c', { ${pab} });\nencryptBucketAtRest('c', c);`;
    expect(analyze(other).problems()).toEqual(['b has no encryptBucketAtRest call']);
  });

  it.each([
    ['an inline BPA object', `{ transform: { publicAccessBlock: { blockPublicAcls: true } } }`],
    ['a spread BPA object', `{ transform: { publicAccessBlock: { ...BLOCK_ALL_PUBLIC_ACCESS } } }`],
    ['spread args', `{ ...shared }`],
    ['access public', `{ access: 'public', ${pab} }`],
    ['public true', `{ public: true, ${pab} }`],
  ])('reports %s', (_label, args) => {
    const src = `const b = new sst.aws.Bucket('b', ${args});\nencryptBucketAtRest('b', b);`;
    expect(analyze(src).problems()).toHaveLength(1);
  });

  it('reports a bucket call no variable declaration owns', () => {
    expect(analyze(`buckets.push(new sst.aws.Bucket('x', {}));`).unattributed).toBe(1);
  });
});
