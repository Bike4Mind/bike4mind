import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as atlassianConstants from '../atlassian/constants.js';
import * as githubConstants from '../github/constants.js';

const SRC_DIR = join(__dirname, '..');

/** Constant names passed as `tool:` in a preview's execParams, i.e. the tools that issue a confirm token. */
function tokenEmittingConstantNames(dirs: string[]): Set<string> {
  const names = new Set<string>();
  for (const dir of dirs) {
    for (const file of readdirSync(join(SRC_DIR, dir)).filter(f => f.endsWith('.ts'))) {
      const source = readFileSync(join(SRC_DIR, dir, file), 'utf8');
      for (const match of source.matchAll(/\btool:\s*([A-Z][A-Z_]+)\b/g)) names.add(match[1]);
    }
  }
  return names;
}

function resolveToolNames(constantNames: Set<string>, constants: Record<string, unknown>): string[] {
  return [...constantNames].map(name => {
    const value = constants[name];
    if (typeof value !== 'string') throw new Error(`${name} is not an exported tool-name constant`);
    return value;
  });
}

describe('confirmable tool allowlists', () => {
  it('GITHUB_CONFIRMABLE_TOOLS is exactly the GitHub tools that issue a confirm token', () => {
    const emitted = resolveToolNames(tokenEmittingConstantNames(['github/tools']), githubConstants);
    expect(new Set(emitted)).toEqual(githubConstants.GITHUB_CONFIRMABLE_TOOLS);
  });

  it('ATLASSIAN_CONFIRMABLE_TOOLS is exactly the Atlassian tools that issue a confirm token', () => {
    const emitted = resolveToolNames(
      tokenEmittingConstantNames(['atlassian/tools', 'atlassian/helpers']),
      atlassianConstants
    );
    expect(new Set(emitted)).toEqual(atlassianConstants.ATLASSIAN_CONFIRMABLE_TOOLS);
  });

  it('the two allowlists are disjoint, so a tool name maps to exactly one server', () => {
    const overlap = [...githubConstants.GITHUB_CONFIRMABLE_TOOLS].filter(tool =>
      atlassianConstants.ATLASSIAN_CONFIRMABLE_TOOLS.has(tool)
    );
    expect(overlap).toEqual([]);
  });
});
