/**
 * @vitest-environment node
 *
 * The contributed-secret spread must come first in these environment blocks so a core
 * variable of the same name always overrides it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SPREAD = '...contributedSecretEnvironment(),';

describe('contributedSecretEnvironment placement', () => {
  it.each(['agentExecutor.ts', 'chatCompletion.ts'])('%s spreads it before every other environment key', file => {
    const src = readFileSync(join(__dirname, '..', file), 'utf8');
    const match = /^ {2}environment: \{\n/m.exec(src);
    expect(match).not.toBeNull();
    const body = src.slice(match!.index + match![0].length);
    const first = body
      .split('\n')
      .map(line => line.trim())
      .find(line => line !== '' && !line.startsWith('//'));
    expect(first).toBe(SPREAD);
  });
});
