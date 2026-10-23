import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const source = ts.createSourceFile(
  'index.tsx',
  readFileSync(new URL('../index.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);

function featureRegistryReservations(): string[] {
  const reservations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'buildFeatureRegistry') {
      const argument = node.arguments[0];
      if (argument && ts.isObjectLiteralExpression(argument)) {
        const property = argument.properties.find(
          candidate => ts.isPropertyAssignment(candidate) && candidate.name.getText(source) === 'reservedToolNames'
        );
        reservations.push(property?.getText(source) ?? '');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return reservations;
}

describe('deferred tool names reserved against plugins', () => {
  it('covers both interactive feature registry construction sites', () => {
    expect(featureRegistryReservations()).toHaveLength(2);
  });

  it.each([
    ['startup', 0],
    ['configuration reload', 1],
  ] as const)('reserves unloaded deferred names during %s', (_name, index) => {
    expect(featureRegistryReservations()[index]).toContain('...deferredToolRegistry.getDirectoryNames()');
    expect(featureRegistryReservations()[index]).toContain("'tool_search'");
  });
});
