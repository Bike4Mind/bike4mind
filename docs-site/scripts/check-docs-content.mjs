#!/usr/bin/env node
// Generic sensitive-shape guard for the public docs. Name-based scanning is deliberately
// absent: a denylist of internal names committed here would itself leak them.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Adding an entry publishes that directory: also add it to `exclude` in docusaurus.config.ts if it is not public.
export const KNOWN_TOP_LEVEL = [
  'admin',
  'agents',
  'api',
  'architecture',
  'cli',
  'databases',
  'deployment',
  'developers',
  'features',
  'files',
  'getting-started',
  'model-cards',
  'security',
  'self-host',
  'testing',
];

const IGNORE_MARKER = '<!-- docs-guard-ignore-next-line -->';
const PLACEHOLDER_ACCOUNTS = new Set(['123456789012', '987654321098', '000000000000']);
const PLACEHOLDER_PASSWORD = /^(password|pass|<[^>]*>|\$\{[^}]*\}|x{3,}|changeme|your-.*|\*+)$/i;
const ALLOWED_EMAIL_DOMAIN =
  /^((.+\.)?example\.(com|org|net)|acme[a-z0-9-]*\.[a-z.]+|(myapp|yourdomain|yourcompany|company|y)\.com|github\.com)$/i;
// Marks an identifier as an obvious stand-in: bracket/angle/shell placeholders, wildcards, or example-ish words.
const PLACEHOLDER_RESOURCE = /[<>[\]*{}$]|\.\.\.|example|your|xxx|^my[-_]?|bucket-name|placeholder/i;
const REAL_CLOUDFRONT_ID = /^d[a-z0-9]{12,13}$/;
const REAL_API_GATEWAY_ID = /^[a-z0-9]{10}$/;
const PLACEHOLDER_OWNER = /^(org|owner|your-org|your-username|acme[a-z0-9-]*)$/i;

const rules = [
  {
    name: 'aws-account-id',
    test: (line) =>
      [...line.matchAll(/(?<![0-9A-Za-z])[0-9]{12}(?![0-9A-Za-z])/g)]
        .filter((m) => !PLACEHOLDER_ACCOUNTS.has(m[0]))
        .map((m) => m[0]),
  },
  {
    name: 'aws-account-id-dashed',
    test: (line) =>
      [...line.matchAll(/(?<![0-9A-Za-z-])[0-9]{4}-[0-9]{4}-[0-9]{4}(?![0-9A-Za-z-])/g)]
        .filter((m) => !PLACEHOLDER_ACCOUNTS.has(m[0].replaceAll('-', '')))
        .map((m) => m[0]),
  },
  {
    name: 'aws-arn',
    test: (line) =>
      [...line.matchAll(/arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:([^:\s]*):[^\s"'`)]*/g)]
        .filter((m) => /^[0-9]{12}$/.test(m[1]) && !PLACEHOLDER_ACCOUNTS.has(m[1]))
        .map((m) => m[0]),
  },
  {
    name: 'aws-arn-no-account',
    test: (line) =>
      [...line.matchAll(/arn:aws[a-z-]*:s3:::([^\s"'`),/]+)/g)]
        .filter((m) => !PLACEHOLDER_RESOURCE.test(m[1]))
        .map((m) => m[0]),
  },
  {
    name: 'aws-resource-host',
    test: (line) => [
      ...[...line.matchAll(/\b([a-z0-9]+)\.cloudfront\.net\b/g)]
        .filter((m) => REAL_CLOUDFRONT_ID.test(m[1]) && !PLACEHOLDER_RESOURCE.test(m[1]))
        .map((m) => m[0]),
      ...[...line.matchAll(/\b([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])\.s3[.-](?:[a-z0-9-]+\.)*amazonaws\.com\b/g)]
        .filter((m) => !PLACEHOLDER_RESOURCE.test(m[1]))
        .map((m) => m[0]),
      ...[...line.matchAll(/\bs3[.-][a-z0-9-]+\.amazonaws\.com\/([A-Za-z0-9][A-Za-z0-9._-]{2,62})/g)]
        .filter((m) => !PLACEHOLDER_RESOURCE.test(m[1]))
        .map((m) => m[0]),
      ...[...line.matchAll(/\b([a-z0-9]+)\.execute-api\.[a-z0-9-]+\.amazonaws\.com\b/g)]
        .filter((m) => REAL_API_GATEWAY_ID.test(m[1]) && !PLACEHOLDER_RESOURCE.test(m[1]))
        .map((m) => m[0]),
    ],
  },
  { name: 'aws-access-key-id', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  {
    name: 'credentialed-url',
    test: (line) =>
      [...line.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/([^\s:/@]+):([^\s@/]+)@[^\s/]+/gi)]
        .filter((m) => !PLACEHOLDER_PASSWORD.test(m[2]))
        .map((m) => m[0]),
  },
  {
    name: 'token-prefix',
    test: (line) =>
      [
        ...line.matchAll(
          /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,}|xox[bpa]-[0-9]+-[A-Za-z0-9-]{8,}|xapp-[0-9]-[A-Za-z0-9-]{8,}|[sr]k_live_[A-Za-z0-9]{16,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{48}|AIza[0-9A-Za-z_-]{35})/g
        ),
      ]
        .filter((m) => !PLACEHOLDER_RESOURCE.test(m[0]))
        .map((m) => m[0]),
  },
  { name: 'internal-hostname', re: /\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(internal|corp)(?![-\w])/gi },
  {
    name: 'email',
    test: (line) =>
      // `:` before the local part is excluded (scheme://user:pass@host), except for mailto: links.
      [...line.matchAll(/(?:(?<![A-Za-z0-9._%+:-])|(?<=mailto:))[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)(:?)/g)]
        .filter(
          (m) =>
            m[0].replace(/:$/, '').toLowerCase() !== 'support@bike4mind.com' &&
            !ALLOWED_EMAIL_DOMAIN.test(m[1]) &&
            !(m[0].startsWith('git@') && m[2] === ':')
        )
        .map((m) => m[0]),
  },
  {
    name: 'tracker-reference',
    test: (line) => [
      ...[...line.matchAll(/github\.com\/([A-Za-z0-9_.-]+)\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/[0-9]+/g)]
        .filter((m) => !PLACEHOLDER_OWNER.test(m[1]))
        .map((m) => m[0]),
      ...[...line.matchAll(/(?<![A-Za-z0-9_./#-])([A-Za-z0-9_.-]+)\/[A-Za-z0-9_.-]+#[0-9]+\b/g)]
        .filter((m) => !PLACEHOLDER_OWNER.test(m[1]))
        .map((m) => m[0]),
    ],
  },
];

export function scanText(text) {
  const findings = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (i > 0 && lines[i - 1].trim() === IGNORE_MARKER) return;
    for (const rule of rules) {
      const hits = rule.test ? rule.test(line) : [...line.matchAll(rule.re)].map((m) => m[0]);
      if (hits.length > 0) findings.push({ line: i + 1, rule: rule.name });
    }
  });
  return findings;
}

export function checkTopLevel(dirs) {
  return dirs.filter((d) => !KNOWN_TOP_LEVEL.includes(d));
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const docsDir = join(root, 'docs');
  const failures = [];

  const topDirs = readdirSync(docsDir).filter((n) => statSync(join(docsDir, n)).isDirectory());
  for (const d of checkTopLevel(topDirs)) {
    failures.push(
      `docs/${d}: new top-level directory. Add it deliberately to KNOWN_TOP_LEVEL in scripts/check-docs-content.mjs and, if it is not for the public site, to the exclude list in docusaurus.config.ts (rule: unknown-top-level-dir)`
    );
  }

  for (const file of walk(docsDir).filter((f) => /\.(md|mdx|json)$/.test(f))) {
    for (const f of scanText(readFileSync(file, 'utf8'))) {
      failures.push(`${relative(root, file)}:${f.line} (rule: ${f.rule})`);
    }
  }

  if (failures.length > 0) {
    console.error(`Docs content guard failed (${failures.length}):\n`);
    for (const f of failures) console.error(`  ${f}`);
    console.error(
      `\nThese pages are published publicly. Remove or replace the content with a placeholder. For a verified false positive, put ${IGNORE_MARKER} on the line directly above it.`
    );
    process.exit(1);
  }
  console.log('Docs content guard passed.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
