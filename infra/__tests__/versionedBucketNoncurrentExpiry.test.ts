/**
 * @vitest-environment node
 *
 * Structural guard: every S3 bucket in infra/ that is versioned (any `versioning:` value other than the
 * literal `false`) must have a lifecycle config that expires noncurrent versions within MAX_NONCURRENT_DAYS.
 * Without one, a delete or overwrite on a versioned stage keeps the old bytes forever.
 *
 * infra/ files use SST globals at module scope, so the source is read as text (same approach as
 * fabFileBucketLifecycle.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const INFRA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_NONCURRENT_DAYS = 30;
const SHARED_RULE = 'expireNoncurrentVersionsRule';

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/.*$/gm, '');

const BUCKET_CALL = /new\s+sst\.aws\.Bucket\(/g;
const BUCKET_DECL = /^(?:export\s+)?const\s+(\w+)\s*=\s*new\s+sst\.aws\.Bucket\(/gm;

// Every bucket declaration, each owning the text up to the next declaration (or end of file).
// `unattributed` counts `new sst.aws.Bucket(` calls no declaration claimed, so an unknown form fails loudly.
const findBuckets = (src: string) => {
  const code = stripComments(src);
  const decls = [...code.matchAll(BUCKET_DECL)];
  const buckets = decls.map((m, i) => ({
    name: m[1],
    versioned: /\bversioning:\s*(?!false\b)\S/.test(code.slice(m.index, decls[i + 1]?.index)),
  }));
  return { buckets, unattributed: [...code.matchAll(BUCKET_CALL)].length - decls.length };
};

// Each BucketLifecycleConfigurationV2 call, up to the next one (or end of file).
const lifecycleFor = (name: string, src: string) =>
  stripComments(src)
    .split('new aws.s3.BucketLifecycleConfigurationV2(')
    .slice(1)
    .find(block => new RegExp(`bucket:\\s*${name}\\.name\\b`).test(block)) ?? '';

const sharedRuleSource = (src: string) =>
  stripComments(src).match(new RegExp(`const ${SHARED_RULE} = \\{[\\s\\S]*?\\n\\};`))?.[0] ?? '';

// The shared rule counts only as a `rules` array element, so a mention in a comment or other property does not.
const usesSharedRule = (lifecycle: string) =>
  new RegExp(`(?:^|[\\[,])\\s*${SHARED_RULE}\\s*(?:,|\\])`, 'm').test(lifecycle);

const BUCKET_WIDE_RULE = /id:\s*'expire-noncurrent-versions',\s*status:\s*'Enabled',\s*filter:\s*\{\}/;

// Returns a failure message, or null when the bucket's lifecycle expires noncurrent versions bucket-wide.
const noncurrentExpiryProblem = (name: string, src: string) => {
  const lifecycle = lifecycleFor(name, src);
  if (!lifecycle) return `${name} has no BucketLifecycleConfigurationV2`;

  const ruleText = usesSharedRule(lifecycle) ? sharedRuleSource(src) : lifecycle;
  if (!ruleText) return `${name} references ${SHARED_RULE} but it is not defined in the file`;
  if (!BUCKET_WIDE_RULE.test(ruleText)) return `${name} rule is not an Enabled, bucket-wide expire-noncurrent-versions`;

  const days = [...ruleText.matchAll(/noncurrentDays:\s*(\d+)/g)].map(m => Number(m[1]));
  if (days.length === 0) return `${name} lifecycle has no noncurrentVersionExpiration`;
  if (Math.min(...days) > MAX_NONCURRENT_DAYS) return `${name} noncurrent window exceeds ${MAX_NONCURRENT_DAYS} days`;
  return null;
};

const files = readdirSync(INFRA_DIR)
  .filter(f => f.endsWith('.ts'))
  .map(f => ({ file: f, src: readFileSync(path.join(INFRA_DIR, f), 'utf8') }));
const found = files.map(f => ({ ...f, ...findBuckets(f.src) }));
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

  it('attributes every `new sst.aws.Bucket(` to a declaration', () => {
    expect(found.filter(f => f.unattributed !== 0).map(f => f.file)).toEqual([]);
  });

  it.each(versionedBuckets.map(b => [b.name, b.src] as const))('%s has a noncurrent expiry rule', (name, src) => {
    expect(noncurrentExpiryProblem(name, src)).toBeNull();
  });
});

describe('guard parsing', () => {
  const lifecycle = (rules: string) =>
    `new aws.s3.BucketLifecycleConfigurationV2('l', { bucket: fooBucket.name, rules: [${rules}] });`;
  const rule = `const ${SHARED_RULE} = {\n  id: 'expire-noncurrent-versions',\n  status: 'Enabled',\n  filter: {},\n  noncurrentVersionExpiration: { noncurrentDays: 30 },\n};\n`;

  it.each([
    ['export const', `export const fooBucket = new sst.aws.Bucket('fooBucket', { versioning: true });`],
    ['multi-line', `const fooBucket =\n  new sst.aws.Bucket('fooBucket', { versioning: true });`],
  ])('finds a versioned %s bucket', (_label, src) => {
    expect(findBuckets(src)).toEqual({ buckets: [{ name: 'fooBucket', versioned: true }], unattributed: 0 });
  });

  it('does not treat `versioning: false` as versioned', () => {
    expect(findBuckets(`const b = new sst.aws.Bucket('b', { versioning: false });`).buckets[0].versioned).toBe(false);
  });

  it('reports a bucket call no declaration owns', () => {
    expect(findBuckets(`buckets.push(new sst.aws.Bucket('x', {}));`).unattributed).toBe(1);
  });

  it('accepts the shared rule as a rules element', () => {
    expect(noncurrentExpiryProblem('fooBucket', rule + lifecycle(SHARED_RULE))).toBeNull();
  });

  it.each([
    ['a prefix filter', rule.replace('filter: {}', "filter: { prefix: 'x/' }")],
    ['a Disabled status', rule.replace("'Enabled'", "'Disabled'")],
  ])('rejects the shared rule with %s', (_label, src) => {
    expect(noncurrentExpiryProblem('fooBucket', src + lifecycle(SHARED_RULE))).not.toBeNull();
  });

  it('ignores a shared-rule mention that is only in a comment', () => {
    expect(noncurrentExpiryProblem('fooBucket', rule + lifecycle(`/* ${SHARED_RULE} */`))).not.toBeNull();
    expect(noncurrentExpiryProblem('fooBucket', rule + lifecycle(`] // ${SHARED_RULE}\n[`))).not.toBeNull();
  });
});
