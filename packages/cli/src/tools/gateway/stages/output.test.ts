import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ApiClient } from '../../../auth/ApiClient.js';
import { MAX_TOOL_OUTPUT_CHARS } from '../../../utils/toolOutputSanitizer.js';
import { executeSanitized, sanitizeThrown } from './output.js';

const apiClient = {} as ApiClient;
// A local tool: executeTool runs the passed implementation, no network.
const LOCAL_TOOL = 'math_evaluate';
const GITHUB_TOKEN = 'ghp_' + 'b'.repeat(36);

function run(fn: () => Promise<string>): Promise<string> {
  return executeSanitized(LOCAL_TOOL, {}, apiClient, fn);
}

describe('executeSanitized', () => {
  it('returns ordinary output unchanged', async () => {
    await expect(run(async () => 'the answer is 42')).resolves.toBe('the answer is 42');
  });

  it('redacts a secret in a returned result', async () => {
    const result = await run(async () => `token is ${GITHUB_TOKEN}`);
    expect(result).not.toContain(GITHUB_TOKEN);
    expect(result).toContain('[REDACTED]');
  });

  it('caps an oversize result with a truncation marker', async () => {
    const result = await run(async () => 'x'.repeat(MAX_TOOL_OUTPUT_CHARS + 1000));
    expect(result.startsWith('x'.repeat(MAX_TOOL_OUTPUT_CHARS))).toBe(true);
    expect(result).toContain('[output truncated: 1000 of');
  });

  it('redacts before capping, so a secret straddling the cut leaves no prefix', async () => {
    const secret = 'sk-' + 'z'.repeat(40);
    const padding = 'a'.repeat(MAX_TOOL_OUTPUT_CHARS - 10);
    const result = await run(async () => `${padding} ${secret} ${'b'.repeat(100)}`);
    expect(result).not.toContain('zzzz');
    expect(result).toContain('[output truncated:');
  });

  it('redacts and caps a thrown error, keeping the same error instance', async () => {
    class ToolFailure extends Error {
      readonly code = 'E_TOOL';
    }
    const thrown = new ToolFailure(`upstream rejected key ${GITHUB_TOKEN} ${'y'.repeat(MAX_TOOL_OUTPUT_CHARS)}`);
    const caught = await run(async () => {
      throw thrown;
    }).catch((error: unknown) => error);

    expect(caught).toBe(thrown);
    expect(thrown.code).toBe('E_TOOL');
    expect(thrown.message).not.toContain(GITHUB_TOKEN);
    expect(thrown.message).toContain('[output truncated:');
  });
});

describe('sanitizeThrown', () => {
  it('wraps a non-Error throw in a sanitized Error', () => {
    const error = sanitizeThrown(`bad ${GITHUB_TOKEN}`);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('bad [REDACTED]');
  });
});

describe('tool execution entry point', () => {
  // ToolRouter.executeTool returns raw output; any caller outside this stage would hand the
  // model unredacted, uncapped text.
  it('is called only from the output stage', () => {
    const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    // Any reference to the module (static, namespace, dynamic or re-export) plus the name.
    const importers = sourceFiles(srcRoot)
      .filter(file => {
        const source = readFileSync(file, 'utf8');
        return /ToolRouter(\.js)?['"]/.test(source) && /\bexecuteTool\b/.test(source);
      })
      .map(file => path.relative(srcRoot, file));
    expect(importers).toEqual([path.join('tools', 'gateway', 'stages', 'output.ts')]);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return entry === 'node_modules' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}
