import { describe, expect, it } from 'vitest';
import { bundleProblems, bundleSpecifiers, type BundleChunk } from './verifyBundle';

const chunk = (code: string, imports: string[] = []): BundleChunk => ({
  fileName: 'b4m-host.mjs',
  code,
  imports,
  dynamicImports: [],
});

describe('bundleProblems', () => {
  it('passes one file that imports only node: built-ins', () => {
    const code = 'import { createServer } from "node:http";\nconst fs = await import("node:fs");\n';
    expect(bundleProblems([chunk(code, ['node:http'])])).toEqual([]);
  });

  it('flags bare built-ins, packages, require calls, extra files and size over budget', () => {
    const code = 'import os from "os";\nimport { z } from "zod";\nconst y = require("yaml");\nimport("./chunk.mjs");\n';
    expect(bundleSpecifiers(chunk(code))).toEqual(['./chunk.mjs', 'os', 'yaml', 'zod']);
    const problems = bundleProblems([chunk(code), { ...chunk(''), fileName: 'other.mjs' }], 16);
    expect(problems).toEqual([
      'expected one output file, got 2: b4m-host.mjs, other.mjs',
      'b4m-host.mjs imports ./chunk.mjs',
      'b4m-host.mjs imports os',
      'b4m-host.mjs imports yaml',
      'b4m-host.mjs imports zod',
      `b4m-host.mjs is ${code.length} bytes, over the 16 byte budget`,
    ]);
  });
});
