// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readInfra = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

describe('signup grant held release dead letter', () => {
  it('registers a DLQ alarm for the cron-sourced queue', () => {
    const source = readInfra('dlqAlarms.ts');
    const block = source.slice(
      source.indexOf('if (signupGrantHeldReleaseDeadLetter)'),
      source.indexOf('// FabFile Moderation DLQ')
    );
    const verify = (alarm: string) => expect(alarm).toContain('queue: signupGrantHeldReleaseDeadLetter.queue,');
    verify(block);
    expect(() => verify(block.replace('queue: signupGrantHeldReleaseDeadLetter.queue,', ''))).toThrow();
  });
});
