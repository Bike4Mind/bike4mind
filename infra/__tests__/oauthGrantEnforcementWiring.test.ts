/** @vitest-environment node */
import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Evaluate only the configured property: loading web.ts itself requires the SST runtime.
const source = ts.createSourceFile(
  'web.ts',
  readFileSync(join(__dirname, '..', 'web.ts'), 'utf8'),
  ts.ScriptTarget.Latest,
  true
);
const expressions: string[] = [];
const collectGrantEnvironment = (node: ts.Node): void => {
  if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'OAUTH_AI_TOKEN_ENFORCE_GRANT') {
    expressions.push(node.initializer.getText(source));
  }
  ts.forEachChild(node, collectGrantEnvironment);
};
collectGrantEnvironment(source);

describe('OAuth AI-token grant enforcement environment', () => {
  it('defines exactly one web environment value', () => {
    expect(expressions).toHaveLength(1);
  });

  it.each([
    { stage: 'production', preview: false, override: undefined, expected: 'true' },
    { stage: 'dev', preview: false, override: undefined, expected: 'true' },
    { stage: 'pr5041', preview: true, override: undefined, expected: 'true' },
    { stage: 'personal', preview: true, override: undefined, expected: 'true' },
    { stage: 'personal', preview: false, override: undefined, expected: '' },
    { stage: 'selfhost', preview: false, override: undefined, expected: '' },
    { stage: 'pr5041', preview: true, override: 'false', expected: 'false' },
    { stage: 'production', preview: false, override: 'false', expected: 'false' },
    { stage: 'selfhost', preview: false, override: 'true', expected: 'true' },
    { stage: 'pr5041', preview: true, override: '', expected: 'true' },
  ])('stage=$stage preview=$preview override=$override yields $expected', ({ stage, preview, override, expected }) => {
    expect(expressions).toHaveLength(1);
    const configuredValue: unknown = runInNewContext(expressions[0], {
      process: { env: { OAUTH_AI_TOKEN_ENFORCE_GRANT: override } },
      $app: { stage },
      PRODUCTION_STAGES: ['production', 'dev'],
      isPreviewStage: preview,
    });
    expect(configuredValue).toBe(expected);
  });
});
