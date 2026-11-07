/**
 * @vitest-environment node
 *
 * Structural guard: every S3 bucket in infra/ that is versioned (any `versioning` value other than the
 * literal `false`) must have a lifecycle config with a bucket-wide `expire-noncurrent-versions` rule that
 * expires noncurrent versions within MAX_NONCURRENT_DAYS. Without one, a delete or overwrite on a versioned
 * stage keeps the old bytes forever.
 *
 * infra/ files use SST globals at module scope, so each file is parsed (not imported) with the TypeScript
 * compiler API. A form the parser cannot resolve fails loudly instead of being skipped.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ts from 'typescript';

const INFRA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_NONCURRENT_DAYS = 30;
const RULE_ID = 'expire-noncurrent-versions';

const unwrap = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)
    ? unwrap(node.expression)
    : node;

// The initializer of `name` in an object literal; `undefined` when absent. Shorthand yields the identifier.
const prop = (obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined => {
  for (const p of obj.properties) {
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return p.name;
    if (ts.isPropertyAssignment(p) && p.name.getText() === name) return unwrap(p.initializer);
  }
  return undefined;
};

const calleeIs = (node: ts.NewExpression, text: string) => node.expression.getText() === text;

type BucketInfo = { name: string; versioned: boolean; undeterminable: boolean };

const analyze = (src: string) => {
  const sf = ts.createSourceFile('infra.ts', src, ts.ScriptTarget.Latest, true);
  const buckets: BucketInfo[] = [];
  const lifecycles: ts.ObjectLiteralExpression[] = [];
  const consts = new Map<string, ts.Expression>();
  let unattributed = 0;

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      consts.set(node.name.text, unwrap(node.initializer));
    }
    if (ts.isNewExpression(node) && calleeIs(node, 'sst.aws.Bucket')) {
      const owner = ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name) ? node.parent : null;
      if (!owner) {
        unattributed++;
      } else {
        const args = node.arguments?.[1] && unwrap(node.arguments[1]);
        let versioned = false;
        let undeterminable = false;
        if (args && !ts.isObjectLiteralExpression(args)) {
          versioned = undeterminable = true;
        } else if (args) {
          const v = prop(args, 'versioning');
          versioned = v ? v.kind !== ts.SyntaxKind.FalseKeyword : false;
          if (args.properties.some(ts.isSpreadAssignment)) versioned = undeterminable = true;
        }
        buckets.push({ name: (owner.name as ts.Identifier).text, versioned, undeterminable });
      }
    }
    if (ts.isNewExpression(node) && calleeIs(node, 'aws.s3.BucketLifecycleConfigurationV2')) {
      const args = node.arguments?.[1] && unwrap(node.arguments[1]);
      if (args && ts.isObjectLiteralExpression(args)) lifecycles.push(args);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // Resolve a `rules` element (inline object, or an identifier declared in this file) to its object literal.
  const resolve = (e: ts.Expression): ts.ObjectLiteralExpression | undefined => {
    const x = unwrap(e);
    if (ts.isObjectLiteralExpression(x)) return x;
    const init = ts.isIdentifier(x) ? consts.get(x.text) : undefined;
    return init && ts.isObjectLiteralExpression(init) ? init : undefined;
  };

  // Returns a failure message, or null when the bucket's own lifecycle has a good bucket-wide rule.
  const problem = (name: string): string | null => {
    const lc = lifecycles.find(l => prop(l, 'bucket')?.getText() === `${name}.name`);
    if (!lc) return `${name} has no BucketLifecycleConfigurationV2`;
    const rules = prop(lc, 'rules');
    if (!rules || !ts.isArrayLiteralExpression(rules)) return `${name} lifecycle rules is not an array literal`;
    const rule = rules.elements
      .map(resolve)
      .find(
        r =>
          r &&
          prop(r, 'id') &&
          ts.isStringLiteralLike(prop(r, 'id')!) &&
          (prop(r, 'id') as ts.StringLiteral).text === RULE_ID
      );
    if (!rule) return `${name} has no ${RULE_ID} rule`;
    const status = prop(rule, 'status');
    if (!status || !ts.isStringLiteralLike(status) || status.text !== 'Enabled')
      return `${name} ${RULE_ID} is not Enabled`;
    const filter = prop(rule, 'filter');
    if (!filter || !ts.isObjectLiteralExpression(filter) || filter.properties.length !== 0) {
      return `${name} ${RULE_ID} is not bucket-wide (filter must be {})`;
    }
    const exp = prop(rule, 'noncurrentVersionExpiration');
    const daysNode = exp && ts.isObjectLiteralExpression(exp) ? prop(exp, 'noncurrentDays') : undefined;
    if (!daysNode || !ts.isNumericLiteral(daysNode)) return `${name} ${RULE_ID} has no noncurrentVersionExpiration`;
    if (Number(daysNode.text) > MAX_NONCURRENT_DAYS)
      return `${name} noncurrent window exceeds ${MAX_NONCURRENT_DAYS} days`;
    return null;
  };

  return { buckets, unattributed, problem };
};

// Every problem in one source: undeterminable versioning, plus a missing/bad rule on each versioned bucket.
const problemsIn = (src: string) => {
  const a = analyze(src);
  return [
    ...a.buckets.filter(b => b.undeterminable).map(b => `${b.name} versioning cannot be determined`),
    ...a.buckets.filter(b => b.versioned).map(b => a.problem(b.name)),
  ].filter((p): p is string => p !== null);
};

const files = readdirSync(INFRA_DIR)
  .filter(f => f.endsWith('.ts'))
  .map(f => ({ file: f, src: readFileSync(path.join(INFRA_DIR, f), 'utf8') }));
const found = files.map(f => ({ ...f, ...analyze(f.src) }));
const versionedBuckets = found.flatMap(f =>
  f.buckets.filter(b => b.versioned).map(b => ({ name: b.name, src: f.src }))
);

describe('versioned buckets expire noncurrent versions', () => {
  it('finds the versioned buckets (guards the guard)', () => {
    expect(versionedBuckets.map(b => b.name)).toEqual(
      expect.arrayContaining([
        'fabFileBucket',
        'generatedImagesBucket',
        'appFilesBucket',
        'historyImportBucket',
        'publishedArtifactsBucket',
      ])
    );
  });

  it('attributes every `new sst.aws.Bucket(` to a variable declaration', () => {
    expect(found.filter(f => f.unattributed !== 0).map(f => f.file)).toEqual([]);
  });

  it('can determine versioning for every bucket', () => {
    expect(found.flatMap(f => f.buckets.filter(b => b.undeterminable).map(b => b.name))).toEqual([]);
  });

  it.each(versionedBuckets.map(b => [b.name, b.src] as const))('%s has a noncurrent expiry rule', (name, src) => {
    expect(analyze(src).problem(name)).toBeNull();
  });
});

describe('guard parsing', () => {
  const rule = (over = '') =>
    `{ id: 'expire-noncurrent-versions', status: 'Enabled', filter: {}, noncurrentVersionExpiration: { noncurrentDays: 30 }${over} }`;
  const bucket = `const fooBucket = new sst.aws.Bucket('fooBucket', { versioning: true });\n`;
  const lifecycle = (rules: string, target = 'fooBucket') =>
    `new aws.s3.BucketLifecycleConfigurationV2('l', { bucket: ${target}.name, rules: [${rules}] });\n`;
  const sharedConst = (body: string, tail = ';') => `const sharedRule = ${body}${tail}\n`;

  it.each([
    ['export const', `export const fooBucket = new sst.aws.Bucket('fooBucket', { versioning: true });`],
    ['multi-line', `const fooBucket =\n  new sst.aws.Bucket('fooBucket', { versioning: true });`],
    ['declared after a `/*` string', `const r = \`\${x.arn}/*\`;\nconst u = '//cdn.example.com';\n${bucket}`],
    ['declared inside a banner after a `/*` string', `const r = \`\${x.arn}/*\`;\n/** Foo */\n${bucket}`],
  ])('finds a versioned %s bucket', (_label, src) => {
    const a = analyze(src);
    expect(a.buckets).toEqual([{ name: 'fooBucket', versioned: true, undeterminable: false }]);
    expect(a.unattributed).toBe(0);
  });

  it('fails a versioned bucket declared after a `/*` string when it has no lifecycle', () => {
    expect(problemsIn(`const r = \`some-prefix/*\`;\n${bucket}`)).toEqual([
      'fooBucket has no BucketLifecycleConfigurationV2',
    ]);
  });

  it('does not treat `versioning: false` as versioned, even with no lifecycle', () => {
    expect(problemsIn(`const b = new sst.aws.Bucket('b', { versioning: false });`)).toEqual([]);
  });

  it('fails a shorthand `{ versioning }` bucket with no lifecycle', () => {
    expect(
      problemsIn(`const versioning = true;\nconst fooBucket = new sst.aws.Bucket('fooBucket', { versioning });`)
    ).toEqual(['fooBucket has no BucketLifecycleConfigurationV2']);
  });

  it('fails loudly on spread args', () => {
    const src = `const fooBucket = new sst.aws.Bucket('fooBucket', { ...shared });`;
    expect(problemsIn(src)).toContain('fooBucket versioning cannot be determined');
  });

  it('reports a bucket call no variable declaration owns', () => {
    expect(analyze(`buckets.push(new sst.aws.Bucket('x', {}));`).unattributed).toBe(1);
  });

  it('accepts an inline rule, with properties in any order', () => {
    expect(problemsIn(bucket + lifecycle(rule()))).toEqual([]);
    const reordered = `{ noncurrentVersionExpiration: { noncurrentDays: 7 }, filter: {}, status: 'Enabled', id: 'expire-noncurrent-versions' }`;
    expect(problemsIn(bucket + lifecycle(reordered))).toEqual([]);
  });

  it('accepts the shared rule as a rules element, with `as const`', () => {
    expect(problemsIn(sharedConst(rule()) + bucket + lifecycle('sharedRule'))).toEqual([]);
    expect(problemsIn(sharedConst(rule(), ' as const') + bucket + lifecycle('sharedRule'))).toEqual([]);
  });

  const prefixed = `{ id: 'p', status: 'Enabled', filter: { prefix: 'x/' }, noncurrentVersionExpiration: { noncurrentDays: 1 } }`;

  it('takes the window only from the bucket-wide rule, not a short prefixed rule', () => {
    const wide365 = rule().replace('noncurrentDays: 30', 'noncurrentDays: 365');
    expect(problemsIn(bucket + lifecycle(`${prefixed}, ${wide365}`))).toEqual([
      'fooBucket noncurrent window exceeds 30 days',
    ]);
    const wideNone = rule().replace(/noncurrentVersionExpiration: \{ noncurrentDays: 30 \}/, '');
    expect(problemsIn(bucket + lifecycle(`${prefixed}, ${wideNone}`))).toEqual([
      'fooBucket expire-noncurrent-versions has no noncurrentVersionExpiration',
    ]);
  });

  it('rejects a shared rule closed with `as const` at 365 days', () => {
    const wide365 = rule().replace('noncurrentDays: 30', 'noncurrentDays: 365');
    expect(problemsIn(sharedConst(wide365, ' as const') + bucket + lifecycle('sharedRule'))).toEqual([
      'fooBucket noncurrent window exceeds 30 days',
    ]);
  });

  it.each([
    ['a prefix filter', rule().replace('filter: {}', "filter: { prefix: 'x/' }")],
    ['a Disabled status', rule().replace("'Enabled'", "'Disabled'")],
  ])('rejects a rule with %s', (_label, r) => {
    expect(problemsIn(bucket + lifecycle(r))).toHaveLength(1);
    expect(problemsIn(sharedConst(r) + bucket + lifecycle('sharedRule'))).toHaveLength(1);
  });

  it('ignores a shared-rule mention that is only in a comment', () => {
    expect(problemsIn(sharedConst(rule()) + bucket + lifecycle(`/* sharedRule */`))).toHaveLength(1);
  });

  it('does not let a bucket borrow another bucket lifecycle through a later resource keyed on it', () => {
    const src =
      `const otherBucket = new sst.aws.Bucket('otherBucket', { versioning: true });\n` +
      lifecycle(rule(), 'otherBucket') +
      bucket +
      `new aws.s3.BucketPublicAccessBlock('pab', { bucket: fooBucket.name, blockPublicAcls: true });\n`;
    expect(problemsIn(src)).toEqual(['fooBucket has no BucketLifecycleConfigurationV2']);
  });
});
