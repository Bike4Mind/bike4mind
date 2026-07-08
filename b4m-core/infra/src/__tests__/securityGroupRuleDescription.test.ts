import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Static-analysis guard for AWS security-group rule descriptions.
 *
 * AWS restricts an SG rule `description` to the charset
 *   ^[0-9A-Za-z_ .:/()#,@[\]+=&;{}!$*-]*$
 * so common characters like `>` and `<` (e.g. an "->" arrow) are rejected at APPLY
 * time, not at typecheck/lint/test. That gap shipped a deploy-breaking regression:
 * a `transform.loadBalancerSecurityGroup` ingress description "CloudFront edge ->
 * public /api/ai/v1/completions" passed every PR check (it's a valid string) and
 * only failed when a fresh SG was created ("ingress.0.description doesn't comply").
 *
 * This test closes that gap with pure string parsing - no AWS calls, no SST imports.
 * It validates `description:` string literals that sit inside a security-group rule
 * (identified by a neighbouring SG-rule key like protocol/fromPort/prefixListIds, or
 * a SecurityGroupRule / loadBalancerSecurityGroup marker) so non-SG descriptions
 * (IAM, alarms, etc., which have different charsets) are not falsely flagged.
 */

// b4m-core/infra/src/__tests__ -> repo root is four levels up.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const INFRA_DIR = resolve(REPO_ROOT, 'infra');

// AWS SG rule description charset. `-` is last so it's a literal, `]` is escaped,
// `/` is escaped for the regexp literal.
const AWS_SG_DESCRIPTION = /^[0-9A-Za-z_ .:\/()#,@[\]+=&;{}!$*-]*$/;

// A `description:` literal is treated as an SG rule description when one of these
// SG-rule signals appears within a small window of preceding lines (same object /
// call). These keys are specific to SG rules and their transforms.
const SG_SIGNALS = [
  'SecurityGroupRule',
  'loadBalancerSecurityGroup',
  'ingress',
  'egress',
  'fromPort',
  'toPort',
  'prefixListIds',
  'cidrBlocks',
  'sourceSecurityGroupId',
];
const WINDOW = 12;

const DESCRIPTION_LITERAL = /description:\s*(['"])((?:\\.|(?!\1).)*)\1/;

/** Recursively collect *.ts files under a directory (skipping node_modules/.sst). */
function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.sst') continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

interface Violation {
  file: string;
  line: number;
  description: string;
  badChars: string[];
}

function findViolations(): Violation[] {
  const violations: Violation[] = [];
  for (const file of collectTsFiles(INFRA_DIR)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const m = DESCRIPTION_LITERAL.exec(line);
      if (!m) return;
      const description = m[2];
      // Only enforce on SG-rule descriptions: require an SG signal nearby.
      const windowStart = Math.max(0, i - WINDOW);
      const context = lines.slice(windowStart, i + 1).join('\n');
      if (!SG_SIGNALS.some(sig => context.includes(sig))) return;
      if (AWS_SG_DESCRIPTION.test(description)) return;
      const badChars = [...new Set([...description].filter(c => !AWS_SG_DESCRIPTION.test(c)))];
      violations.push({ file: relative(REPO_ROOT, file), line: i + 1, description, badChars });
    });
  }
  return violations;
}

describe('security-group rule descriptions comply with the AWS charset', () => {
  it('has no SG rule description with characters AWS rejects at apply time', () => {
    const violations = findViolations();
    const report = violations
      .map(v => `  ${v.file}:${v.line} — bad char(s) ${JSON.stringify(v.badChars)} in "${v.description}"`)
      .join('\n');
    expect(violations, `SG rule descriptions must match ${AWS_SG_DESCRIPTION}\n${report}`).toEqual([]);
  });
});
