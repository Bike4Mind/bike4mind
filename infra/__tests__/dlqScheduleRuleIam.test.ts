/**
 * @vitest-environment node
 *
 * The admin DLQ listing reads scheduled-job rules from the web function. infra/ is an SST program
 * and does not load outside `sst`, so this is a text match like dlqConsumerLogsIam.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ts from 'typescript';
import { stripComments } from './helpers/infraSource';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => stripComments(readFileSync(path.join(REPO_ROOT, 'infra', file), 'utf8'));
const source = read('web.ts');
const INFRA_FILES = readdirSync(path.join(REPO_ROOT, 'infra')).filter(file => file.endsWith('.ts'));

function deadLetteredCronNames(src: string): string[] {
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = node.initializer.getText();
      if (/new sst\.aws\.Cron\(/.test(initializer) && /\.(functionTarget|ruleTarget)\b/.test(initializer)) {
        names.push(node.name.getText());
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile('infra.ts', src, ts.ScriptTarget.Latest, true));
  return names;
}

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
});

describe('web function DLQ rule target log permissions', () => {
  const policySource = read('webDlqFunctionLogs.ts');

  it('grants GetFunctionConfiguration only on the dead-letter rule targets, never a pattern', () => {
    const at = policySource.indexOf("'lambda:GetFunctionConfiguration'");
    expect(at).toBeGreaterThan(-1);
    const statement = policySource.slice(policySource.lastIndexOf('{', at), policySource.indexOf('}', at) + 1);
    expect(statement).toMatch(/resources:\s*\[\.\.\.deadLetterRuleTargetArns\]\s*\}/);
    expect(policySource).not.toContain('*');
    expect(policySource).toMatch(/policyArn:\s*dlqFunctionLogsPolicy\.arn/);
    expect(read('index.ts')).toContain("export * from './webDlqFunctionLogs';");
  });

  it('records the target of every rule allowed to dead-letter', () => {
    expect(read('eventBusDeadLetter.ts')).toMatch(
      /ruleTargetArns\.push\(\s*\.\.\.subscriptions\.map\(subscription => subscription\.apply\(subscriber => subscriber\.nodes\.target\.arn\)\)\s*\)/
    );
  });

  // The list is filled as modules load, so a caller loaded after the policy would be left out.
  it('imports every allowRules caller before reading the list', () => {
    const callers = INFRA_FILES.filter(file => file !== 'eventBusDeadLetter.ts' && read(file).includes('.allowRules('));
    expect(callers.length).toBeGreaterThan(5);
    const missing = callers.filter(file => !policySource.includes(`import './${file.replace(/\.ts$/, '')}';`));
    expect(missing).toEqual([]);
  });

  it('passes every dead-lettered cron to allowRules', () => {
    const deadLettered = INFRA_FILES.flatMap(file => {
      const src = read(file);
      return deadLetteredCronNames(src).map(name => ({
        file,
        name,
        listed: src.includes(`.allowRules([$util.output(${name})])`),
      }));
    });
    expect(deadLettered.length).toBeGreaterThanOrEqual(12);
    expect(deadLettered.filter(cron => !cron.listed).map(cron => `${cron.file}:${cron.name}`)).toEqual([]);
  });

  it('does not attribute an intervening worker DLQ to the preceding cron', () => {
    expect(
      deadLetteredCronNames(`
        const health = enabled ? new sst.aws.Cron('health', { function: {} }) : undefined;
        const worker = new sst.aws.Function('worker', { transform: deadLetter.functionTarget });
        const scan = enabled ? new sst.aws.Cron('scan', {
          job: worker.arn,
          transform: { target: deadLetter.ruleTarget.target },
        }) : undefined;
      `)
    ).toEqual(['scan']);
  });

  it('grants no wildcard on Lambda functions anywhere in infra', () => {
    for (const file of INFRA_FILES) expect(read(file), file).not.toMatch(/:function:[^`'"\s]*\*/);
  });
});
