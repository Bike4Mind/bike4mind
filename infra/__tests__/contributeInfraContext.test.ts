/**
 * @vitest-environment node
 *
 * A package's contributeInfra can subscribe a consumer to its declared queue pair, attach a rule to
 * the shared bus or point an alarm at the alarm topic only when sst.config.ts hands those in.
 * sst.config.ts does not load outside `sst`, so this is a text match.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { soleMatch, stripComments } from './helpers/infraSource';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => stripComments(readFileSync(path.join(REPO_ROOT, rel), 'utf8'));

const HANDED_IN = ['eventBus', 'contributedQueues', 'dlqAlarmTopic'] as const;

describe('contributeInfra context', () => {
  const config = read('sst.config.ts');

  it('reads the bus, the contributed queue pairs and the alarm topic from infra/', () => {
    const [, names] = soleMatch(
      config,
      /const \{([^}]*)\} = await import\('\.\/infra'\);/g,
      "destructured import of './infra'"
    );
    const imported = names.split(',').map(name => name.trim());
    for (const name of HANDED_IN) expect(imported).toContain(name);
  });

  it('exports each of them through the infra/ barrel', () => {
    const barrel = read('infra/index.ts');
    expect(read('infra/bus.ts')).toMatch(/export \{ eventBus \};/);
    expect(read('infra/queues.ts')).toMatch(/export const contributedQueues\b/);
    expect(read('infra/dlqAlarms.ts')).toMatch(/export const dlqAlarmTopic\b/);
    for (const module of ['bus', 'queues', 'dlqAlarms']) {
      expect(barrel).toContain(`export * from './${module}';`);
    }
  });

  it('hands all three to a contributeInfra call', () => {
    const calls = [...config.matchAll(/\bcontribute\w*Infra\(\{([\s\S]*?)\n {4}\}\);/g)].map(match => match[1]);
    expect(calls.length).toBeGreaterThan(0);
    const complete = calls.filter(
      body => /\beventBus,/.test(body) && /\bcontributedQueues,/.test(body) && /\balarmTopic: dlqAlarmTopic,/.test(body)
    );
    expect(complete).toHaveLength(1);
  });
});
