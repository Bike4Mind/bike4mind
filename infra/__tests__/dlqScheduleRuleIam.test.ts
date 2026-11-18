/**
 * @vitest-environment node
 *
 * The admin DLQ listing reads scheduled-job rules from the web function. infra/ is an SST program
 * and does not load outside `sst`, so this is a text match like dlqConsumerLogsIam.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { stripComments } from './helpers/infraSource';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = stripComments(readFileSync(path.join(REPO_ROOT, 'infra/web.ts'), 'utf8'));

function statementFor(action: string): string {
  const at = source.indexOf(`'${action}'`);
  expect(at, `${action} statement`).toBeGreaterThan(-1);
  const start = source.lastIndexOf('{', at);
  return source.slice(start, source.indexOf('}', at) + 1);
}

describe('web function DLQ schedule rule permissions', () => {
  it('grants DescribeRule and ListTargetsByRule together, scoped to this stage', () => {
    const statement = statementFor('events:DescribeRule');
    expect(statement).toContain("'events:ListTargetsByRule'");
    expect(statement).toMatch(/resources:\s*stageRuleArns\s*\}/);
    expect(statement).not.toMatch(/'\*'/);
  });

  // SST drops or truncates the app name from a long rule name, so the full app prefix alone would miss those rules.
  it('scopes the rule ARNs to exact stage prefixes, never a leading wildcard', () => {
    expect(source).toMatch(/:rule\/\$\{prefix\}-\*`/);
    expect(source).not.toMatch(/:rule\/\*/);
    expect(source).toMatch(/\$app\.stage,\s*\.\.\.Array\.from\(\{ length: \$app\.name\.length \+ 1 \}/);
    expect(source).toContain('`${$app.name.slice(0, n)}-${$app.stage}`');
  });

  it('grants GetFunctionConfiguration for the schedule and EventBridge target log links, scoped to this stage', () => {
    const at = source.lastIndexOf("'lambda:GetFunctionConfiguration'");
    const statement = source.slice(source.lastIndexOf('{', at), source.indexOf('}', at) + 1);
    expect(statement).toMatch(/resources:\s*stageFunctionArns\s*\}/);
    expect(statement).not.toMatch(/'\*'/);
    expect(source).toMatch(/const stageFunctionArns = stageRulePrefixes\.map\(/);
    expect(source).toMatch(/:function:\$\{prefix\}-\*`/);
    expect(source).not.toMatch(/:function:\*/);
    expect(source).toMatch(/policyArn:\s*dlqFunctionLogsPolicy\.arn/);
  });
});
