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
import { balanced, soleMatch, stripComments } from './helpers/infraSource';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => stripComments(readFileSync(path.join(REPO_ROOT, rel), 'utf8'));

const HANDED_IN = [
  'eventBus',
  'contributedQueues',
  'dlqAlarmTopic',
  'websocketApi',
  'fabFileBucket',
  'generatedImagesBucket',
  'appFilesBucket',
  'mcpHandler',
  'forwardErrorLogs',
] as const;
const HANDED_IN_AS_IS = HANDED_IN.filter(name => name !== 'dlqAlarmTopic');

describe('contributeInfra context', () => {
  const config = read('sst.config.ts');
  const context = () => {
    const declaration = soleMatch(config, /const infrastructureContext = /g, 'infrastructure context');
    return balanced(config, declaration.index, '{', '}');
  };

  it('reads the shared resources and the log forwarding function from infra/', () => {
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
    expect(read('infra/logMonitor.ts')).toMatch(/export function forwardErrorLogs\(/);
    for (const module of ['bus', 'queues', 'dlqAlarms', 'logMonitor']) {
      expect(barrel).toContain(`export * from './${module}';`);
    }
  });

  it('hands them to a contributeInfra call', () => {
    for (const name of HANDED_IN_AS_IS) expect(context()).toMatch(new RegExp(`\\b${name},`));
    expect(context()).toMatch(/\balarmTopic: dlqAlarmTopic,/);
    soleMatch(config, /\bcontribute\w*Infra\(infrastructureContext\);/g, 'context contribution');
  });

  it('hands in the mail body grants core queue subscribers get, on the app files bucket', () => {
    soleMatch(
      config,
      /const \{ mailBodyEnvironment, mailBodyPutPermission \} = await import\('\.\/infra\/mailBodyOffload'\);/g,
      'mail body helper import'
    );
    expect(context()).toMatch(
      /\bmailBody: \{\s*environment: mailBodyEnvironment\(appFilesBucket\),\s*permission: mailBodyPutPermission\(appFilesBucket\),\s*\}/
    );
  });

  it('creates every log subscription through forwardErrorLogs, which does nothing under sst dev', () => {
    const monitor = read('infra/logMonitor.ts');
    soleMatch(monitor, /new aws\.cloudwatch\.LogSubscriptionFilter\(/g, 'log subscription constructor');
    const declaration = soleMatch(monitor, /export function forwardErrorLogs\(/g, 'forwardErrorLogs');
    const end = monitor.indexOf('\n}\n', declaration.index);
    expect(end).toBeGreaterThan(declaration.index);
    const fn = monitor.slice(declaration.index, end);
    expect(fn).toContain('new aws.cloudwatch.LogSubscriptionFilter(');
    expect(fn).toMatch(/^\s*if \(\$dev\) return \$util\.output\(undefined\);/m);
  });

  it('hands the bus to the heartbeat contributeInfra call through a variable', () => {
    const declaration = soleMatch(config, /const tavernInfraContext = /g, 'heartbeat infra context');
    expect(balanced(config, declaration.index, '{', '}')).toMatch(/\beventBus\b/);
    soleMatch(config, /\bcontributeTavernInfra\(tavernInfraContext\);/g, 'heartbeat infra contribution');
  });
});
