import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

function extractLabels(content: string): string[] {
  const source = ts.createSourceFile('registry.ts', content, ts.ScriptTarget.Latest, true);
  const labels: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(source) === 'label' &&
      ts.isStringLiteral(node.initializer) &&
      ts.isObjectLiteralExpression(node.parent) &&
      node.parent.properties.some(property => property.name?.getText(source) === 'application')
    ) {
      labels.push(node.initializer.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return labels.sort();
}

const repoRoot = path.resolve(__dirname, '../../../../');
const registryLabels = extractLabels(
  readFileSync(path.join(repoRoot, 'packages/server-utils/src/utils/dlqRegistry.ts'), 'utf8')
);
const alarmLabels = extractLabels(readFileSync(path.join(repoRoot, 'infra/dlqAlarms.ts'), 'utf8'));
const missing = (expected: string[], actual: string[]) => expected.filter(label => !actual.includes(label));

describe('DLQ registry sync', () => {
  it('lists every alarmed DLQ, including standalone and out-of-band descriptors', () => {
    expect(alarmLabels).toContain('fab-file-moderation');
    expect(alarmLabels).toContain('alarm-handler');
    expect(missing(alarmLabels, registryLabels)).toEqual([]);
  });

  it('alarms every registered core DLQ', () => {
    expect(missing(registryLabels, alarmLabels)).toEqual([]);
  });

  it('detects label omissions in either direction', () => {
    expect(
      missing(
        alarmLabels,
        registryLabels.filter(label => label !== 'fab-file-moderation')
      )
    ).toEqual(['fab-file-moderation']);
    expect(
      missing(
        registryLabels,
        alarmLabels.filter(label => label !== 'fab-file-moderation')
      )
    ).toEqual(['fab-file-moderation']);
  });

  it.each([
    ['registry', registryLabels],
    ['alarms', alarmLabels],
  ] as const)('has no duplicate labels in %s', (_name, labels) => {
    expect(new Set(labels).size).toBe(labels.length);
  });
});
