import path from 'path';
import { describe, it, expect } from 'vitest';
import { parseEslintOutput, parseTscOutput } from './checkers';

const PROJECT = path.resolve('/workspace/project');

describe('parseTscOutput', () => {
  it('parses --pretty false error lines relative to the tsc cwd', () => {
    const stdout = [
      "src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      "  Type 'string' is not assignable to type 'number'.",
      'src/b.tsx(1,1): error TS2307: Cannot find module "x".',
      "error TS5083: Cannot read file '/workspace/tsconfig.base.json'.",
    ].join('\n');

    expect(parseTscOutput(stdout, PROJECT)).toEqual([
      {
        filePath: path.join(PROJECT, 'src/a.ts'),
        line: 12,
        column: 5,
        code: 'TS2322',
        message: "Type 'string' is not assignable to type 'number'.",
      },
      {
        filePath: path.join(PROJECT, 'src/b.tsx'),
        line: 1,
        column: 1,
        code: 'TS2307',
        message: 'Cannot find module "x".',
      },
    ]);
  });
});

describe('parseEslintOutput', () => {
  it('keeps only error-severity messages', () => {
    const filePath = path.join(PROJECT, 'src/a.ts');
    const stdout = JSON.stringify([
      {
        filePath,
        messages: [
          { severity: 2, line: 4, column: 2, ruleId: 'no-undef', message: "'foo' is not defined." },
          { severity: 1, line: 5, column: 1, ruleId: 'no-console', message: 'Unexpected console statement.' },
          { severity: 2, ruleId: null, message: 'Parsing error: Unexpected token' },
        ],
      },
    ]);

    expect(parseEslintOutput(stdout)).toEqual([
      { filePath, line: 4, column: 2, code: 'no-undef', message: "'foo' is not defined." },
      { filePath, line: 1, column: 1, code: 'eslint', message: 'Parsing error: Unexpected token' },
    ]);
  });

  it('returns no diagnostics for non-JSON output (eslint config failure)', () => {
    expect(parseEslintOutput('Oops! Something went wrong! :(')).toEqual([]);
  });

  it('returns no diagnostics for JSON of an unexpected shape', () => {
    expect(parseEslintOutput('{"not":"a report"}')).toEqual([]);
  });
});
