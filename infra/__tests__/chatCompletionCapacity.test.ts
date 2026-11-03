/**
 * @vitest-environment node
 *
 * Text-matched wiring: infra/chatCompletion.ts is an SST program and does not load outside
 * `sst`, so the call site is read from source while the helper is imported directly.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chatCompletionCapacity } from '../chatCompletionCapacity';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Strip block comments so a commented-out entry cannot satisfy the assertions below.
const readInfra = (file: string) =>
  readFileSync(path.join(REPO_ROOT, 'infra', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const cut = (source: string, start: string, end: string) => {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
};

describe('chatCompletionCapacity', () => {
  it('puts preview stages on Fargate Spot', () => {
    expect(chatCompletionCapacity(true)).toBe('spot');
  });

  it('leaves non-preview stages on the regular Fargate default', () => {
    expect(chatCompletionCapacity(false)).toBeUndefined();
  });
});

describe('ChatCompletion service capacity', () => {
  it('takes its capacity from isPreviewStage', () => {
    const service = cut(readInfra('chatCompletion.ts'), "new sst.aws.Service('ChatCompletion'", '\n});');
    expect(service).toContain('capacity: chatCompletionCapacity(isPreviewStage),');
  });
});
