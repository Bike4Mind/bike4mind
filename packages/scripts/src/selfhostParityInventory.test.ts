import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  discoverParityInventory,
  portableRegistrationFingerprint,
  portableImportCandidates,
  validateParityPolicy,
} from './selfhostParityInventory';
import { selfhostParityPolicy } from './selfhostParityPolicy';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sources = (source: string) => ({ 'infra/test.ts': source });
const queue = "const jobs = new sst.aws.Queue('jobs', {}); jobs.subscribe({handler:'apps/workers/jobs.dispatch'});";

function files(dir: string): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => {
    const name = `${dir}/${entry.name}`;
    return entry.isDirectory() ? files(name) : [name];
  });
}

describe('portable declaration inventory', () => {
  it.each([
    [
      "const job = enabled ? new sst.aws.Cron('daily', {}) : undefined;",
      "const job = other ? new sst.aws.Cron('daily', {}) : undefined;",
    ],
    [
      "const job = enabled ? new sst.aws.Cron('daily', {}) : undefined;",
      "const job = enabled ? undefined : new sst.aws.Cron('daily', {});",
    ],
    [
      "if (enabled) { new sst.aws.Cron('daily', {}); } else {}",
      "if (enabled) {} else { new sst.aws.Cron('daily', {}); }",
    ],
  ])('detects changed conditional execution branches: %s', (before, after) => {
    expect(discoverParityInventory(sources(before))[0].fingerprint).not.toBe(
      discoverParityInventory(sources(after))[0].fingerprint
    );
  });

  it('discovers queues and their subscriptions without loading SST', () => {
    const inventory = discoverParityInventory(sources(queue));
    expect(inventory).toHaveLength(1);
    expect(inventory[0]).toMatchObject({ id: 'queue:infra/test.ts:jobs', handlers: ['apps/workers/jobs.dispatch'] });
  });

  it('retains disabled schedules and literal event payloads', () => {
    const [item] = discoverParityInventory(
      sources(
        "new sst.aws.Cron('daily', {schedule:'rate(1 day)', enabled:false, event:{kind:'daily'}, function:{handler:'apps/workers/daily.handler'}});"
      )
    );
    expect(item).toMatchObject({ kind: 'schedule', name: 'daily', handlers: ['apps/workers/daily.handler'] });
    expect(item.declaration).toContain('enabled');
    expect(item.declaration).toContain('false');
    expect(item.declaration).toContain('daily');
  });

  it('discovers queue-target and function-target bus subscriptions', () => {
    const items = discoverParityInventory(
      sources(
        "const bus = new sst.aws.Bus('bus'); bus.subscribe('first',{handler:'apps/workers/event.handler'},{pattern:{detailType:['event.first']}}); bus.subscribeQueue('second', jobs, {detailType:['event.second']});"
      )
    );
    expect(items.filter(item => item.kind === 'event').map(item => item.name)).toEqual(['first', 'second']);
    expect(items.find(item => item.name === 'second')?.declaration).toContain('jobs');
  });

  it('ignores comments and preserves string contents across formatting changes', () => {
    expect(discoverParityInventory(sources(`// ${queue}\n/* new sst.aws.Cron('no', {}); */`))).toEqual([]);
    const before = discoverParityInventory(sources(queue))[0];
    const after = discoverParityInventory(sources(queue.replace('{}', '{ /* formatting */ }')))[0];
    expect(before.fingerprint).toBe(after.fingerprint);
  });

  it('rejects computed declaration names and options rather than passing vacuously', () => {
    expect(() => discoverParityInventory(sources('new sst.aws.Cron(name, {});'))).toThrow(/literal.*name/i);
    expect(() => discoverParityInventory(sources("new sst.aws.Cron('daily', config);"))).toThrow(/options/i);
  });

  it('supports inline Cron job objects and shared Function ARN targets', () => {
    const items = discoverParityInventory(
      sources(
        "const report = new sst.aws.Function('report', {handler:'apps/workers/report.handler'}); new sst.aws.Cron('inline', {job:{handler:'apps/workers/inline.handler'}}); new sst.aws.Cron('shared', {job:report.arn});"
      )
    );
    expect(items.map(item => item.handlers)).toEqual([
      ['apps/workers/inline.handler'],
      ['apps/workers/report.handler'],
    ]);
  });

  it('follows bus re-exports and shared event Function targets', () => {
    const items = discoverParityInventory({
      'infra/bus.ts': "export const bus = new sst.aws.Bus('bus');",
      'infra/reexport.ts': "import {bus} from './bus'; export {bus};",
      'infra/functions.ts':
        "export const report = new sst.aws.Function('report', {handler:'apps/workers/report.handler'});",
      'infra/test.ts':
        "import {bus} from './reexport'; import {report} from './functions'; bus.subscribe('first', report.arn, {pattern:{detailType:['first']}});",
    });
    expect(items).toHaveLength(1);
    expect(items[0].handlers).toEqual(['apps/workers/report.handler']);
  });

  it('flags direct handler imports and includes raw SQS queue declarations', () => {
    const [item] = discoverParityInventory({
      'infra/test.ts':
        "const jobs = new aws.sqs.Queue('jobs', {}); jobs.subscribe({handler:'apps/workers/jobs.dispatch'});",
      'apps/workers/jobs.ts': "import {BedrockRuntimeClient} from '@aws-sdk/client-bedrock-runtime';",
    });
    expect(item.hostedAwsSignals).toEqual(['import:@aws-sdk/client-bedrock-runtime']);
  });

  it('tracks direct exclusive-provider signals without treating compatible S3/SQS as exclusive', () => {
    const [item] = discoverParityInventory(
      sources(
        "new sst.aws.Cron('daily', {function:{handler:'apps/workers/daily.handler',permissions:[{actions:['bedrock:InvokeModel','s3:GetObject','sqs:SendMessage']}]}});"
      )
    );
    expect(item.hostedAwsSignals).toEqual(['bedrock:InvokeModel']);
  });

  it('rejects an added declaration and stale policy entry', () => {
    const inventory = discoverParityInventory(sources(queue));
    const errors = validateParityPolicy(inventory, [], {});
    expect(errors).toContain('Unreviewed declaration: queue:infra/test.ts:jobs');
    expect(errors).toContain(
      `Declaration snapshot: ${JSON.stringify({ id: inventory[0].id, fingerprint: inventory[0].fingerprint, hostedAwsSignals: inventory[0].hostedAwsSignals })}`
    );
    expect(
      validateParityPolicy(
        [],
        [
          {
            id: 'old',
            fingerprint: 'old',
            disposition: 'pending',
            issue: 'Bike4Mind/bike4mind#2693',
            reason: 'Awaiting outcome proof',
            hostedAwsSignals: [],
          },
        ],
        {}
      )
    ).toContain('Stale policy entry: old');
  });

  it('rejects changed declaration fingerprints and untracked gaps', () => {
    const inventory = discoverParityInventory(sources(queue));
    const entry = { ...inventory[0], disposition: 'pending' as const, issue: '', reason: 'Awaiting proof' };
    const errors = validateParityPolicy(inventory, [{ ...entry, fingerprint: 'old' }], {});
    expect(errors).toContain(`Declaration changed: ${entry.id}`);
    expect(errors).toContain(`Declaration fingerprint after review: ${entry.id}: ${inventory[0].fingerprint}`);
    expect(errors).toContain(`Tracked issue required: ${entry.id}`);
  });

  it('requires portable implementation symbols reachable from the entrypoint', () => {
    const inventory = discoverParityInventory(sources(queue));
    const policy = [
      {
        ...inventory[0],
        disposition: 'portable' as const,
        issue: 'Bike4Mind/bike4mind#2693',
        reason: 'Shared dispatcher',
        portable: { source: 'apps/workers/local.ts', symbol: 'registerJobs', fingerprint: 'old' },
      },
    ];
    expect(
      validateParityPolicy(inventory, policy, {
        'apps/workers/local.ts': 'export function registerJobs() {}',
        'apps/workers/src/selfhost/main.ts': '',
      })
    ).toContain('Portable registration not reachable: queue:infra/test.ts:jobs');
  });

  it('accepts a reviewed registration and detects its removal or body change', () => {
    const inventory = discoverParityInventory(sources(queue));
    const file = 'apps/workers/src/selfhost/jobs.ts';
    const body = 'export function registerJobs(worker: Worker) { worker.registerQueueHandler("jobs", url, dispatch); }';
    const main = "import {registerJobs as register} from './jobs'; async function main(){register(worker);} main();";
    const policy = [
      {
        ...inventory[0],
        disposition: 'portable' as const,
        issue: 'Bike4Mind/bike4mind#2693',
        reason: 'Shared dispatch wiring only',
        portable: {
          source: file,
          symbol: 'registerJobs',
          fingerprint: portableRegistrationFingerprint(body, 'registerJobs')!,
        },
      },
    ];
    const local = {
      [file]: body,
      'apps/workers/src/selfhost/main.ts': main,
      'apps/workers/jobs.ts': 'export function dispatch() {}',
    };
    expect(validateParityPolicy(inventory, policy, local)).toEqual([]);
    const changedBody = body.replace('url', 'otherUrl');
    const errors = validateParityPolicy(inventory, policy, { ...local, [file]: changedBody });
    expect(errors).toContain(`Portable registration changed: ${inventory[0].id}`);
    expect(errors).toContain(
      `Portable fingerprint after review: ${inventory[0].id}: ${portableRegistrationFingerprint(changedBody, 'registerJobs')}`
    );
    expect(
      validateParityPolicy(inventory, policy, {
        ...local,
        'apps/workers/src/selfhost/main.ts': main.replace('register(worker)', ''),
      })
    ).toContain(`Portable registration not reachable: ${inventory[0].id}`);
  });

  it('detects changed schedule, event payload, handler and shared ARN definition', () => {
    const declaration =
      "const shared = new sst.aws.Function('shared',{handler:'apps/workers/one.handler'}); new sst.aws.Cron('daily',{schedule:'rate(1 day)',event:{kind:'daily'},job:shared.arn});";
    const fingerprint = discoverParityInventory(sources(declaration))[0].fingerprint;
    for (const [before, after] of [
      ['rate(1 day)', 'rate(2 days)'],
      ["kind:'daily'", "kind:'weekly'"],
      ['one.handler', 'two.handler'],
    ]) {
      expect(discoverParityInventory(sources(declaration.replace(before, after)))[0].fingerprint).not.toBe(fingerprint);
    }
  });

  it('rejects duplicate identities, malformed source and unresolved ARN targets', () => {
    expect(() => discoverParityInventory(sources("new sst.aws.Cron('same',{}); new sst.aws.Cron('same',{});"))).toThrow(
      /Duplicate/
    );
    expect(() => discoverParityInventory(sources("new sst.aws.Cron('unfinished'"))).toThrow(/cannot parse/);
    expect(() => discoverParityInventory(sources("new sst.aws.Cron('daily',{job:unknown.arn});"))).toThrow(
      /unresolved/
    );
  });

  it('detects changes to referenced local cadence constants', () => {
    const before =
      'const INTERVAL = 60000; async function main(){worker.registerScheduledTask("daily", INTERVAL, callback);}';
    expect(portableRegistrationFingerprint(before, 'schedule:daily')).not.toBe(
      portableRegistrationFingerprint(before.replace('60000', '120000'), 'schedule:daily')
    );
  });

  it('detects hosted ancestor gates and referenced cadence definitions', () => {
    const text =
      "const RATE = 'rate(1 day)'; if ($app.stage === 'production') { new sst.aws.Cron('daily', {schedule:RATE}); }";
    const fingerprint = discoverParityInventory(sources(text))[0].fingerprint;
    expect(discoverParityInventory(sources(text.replace('production', 'dev')))[0].fingerprint).not.toBe(fingerprint);
    expect(discoverParityInventory(sources(text.replace('rate(1 day)', 'rate(2 days)')))[0].fingerprint).not.toBe(
      fingerprint
    );
  });

  it('fails on unresolved subscription receivers instead of losing them', () => {
    expect(() =>
      discoverParityInventory(sources("unknown.subscribe('new-event', {handler:'apps/workers/event.handler'});"))
    ).toThrow(/unresolved subscription/i);
    expect(() =>
      discoverParityInventory(sources("factory().subscribe('new-event', {handler:'apps/workers/event.handler'});"))
    ).toThrow(/unresolved subscription/i);
  });

  it('rejects missing selected portable handler imports', () => {
    const inventory = discoverParityInventory(sources(queue));
    const file = 'apps/workers/src/selfhost/jobs.ts';
    const text =
      "import {dispatch} from '@workers/queueHandlers/missing'; export function registerJobs(worker: Worker){worker.registerQueueHandler('jobs', url, dispatch);}";
    const policy = [
      {
        ...inventory[0],
        disposition: 'portable' as const,
        issue: 'Bike4Mind/bike4mind#2693',
        reason: 'Reviewed wiring',
        portable: {
          source: file,
          symbol: 'registerJobs',
          fingerprint: portableRegistrationFingerprint(text, 'registerJobs')!,
        },
      },
    ];
    const local = {
      [file]: text,
      'apps/workers/src/selfhost/main.ts':
        "import {registerJobs} from './jobs'; function main(){registerJobs(worker);} main();",
    };
    expect(validateParityPolicy(inventory, policy, local)).toContain(
      `Portable import missing: ${inventory[0].id}: @workers/queueHandlers/missing`
    );
  });

  it('does not count a registration called only inside an unused nested helper', () => {
    const inventory = discoverParityInventory(sources(queue));
    const file = 'apps/workers/src/selfhost/jobs.ts';
    const text = 'export function registerJobs() {}';
    const policy = [
      {
        ...inventory[0],
        disposition: 'portable' as const,
        issue: 'Bike4Mind/bike4mind#2693',
        reason: 'Reviewed wiring',
        portable: {
          source: file,
          symbol: 'registerJobs',
          fingerprint: portableRegistrationFingerprint(text, 'registerJobs')!,
        },
      },
    ];
    const local = {
      [file]: text,
      'apps/workers/src/selfhost/main.ts':
        "import {registerJobs} from './jobs'; function main(){function unused(){registerJobs();}} main();",
    };
    expect(validateParityPolicy(inventory, policy, local)).toContain(
      `Portable registration not reachable: ${inventory[0].id}`
    );
  });

  it('does not count a registration hidden in an unused arrow helper', () => {
    const inventory = discoverParityInventory(sources(queue));
    const file = 'apps/workers/src/selfhost/jobs.ts';
    const text = 'export function registerJobs() {}';
    const policy = [
      {
        ...inventory[0],
        disposition: 'portable' as const,
        issue: 'Bike4Mind/bike4mind#2693',
        reason: 'Reviewed wiring',
        portable: {
          source: file,
          symbol: 'registerJobs',
          fingerprint: portableRegistrationFingerprint(text, 'registerJobs')!,
        },
      },
    ];
    const local = {
      [file]: text,
      'apps/workers/src/selfhost/main.ts':
        "import {registerJobs} from './jobs'; function main(){const unused=()=>registerJobs();} main();",
    };
    expect(validateParityPolicy(inventory, policy, local)).toContain(
      `Portable registration not reachable: ${inventory[0].id}`
    );
  });

  it('rejects dependency changes and missing disposition reasons', () => {
    const inventory = discoverParityInventory(sources(queue));
    expect(
      validateParityPolicy(
        inventory,
        [
          {
            ...inventory[0],
            disposition: 'pending',
            issue: 'Bike4Mind/bike4mind#2693',
            reason: '',
            hostedAwsSignals: ['bedrock:InvokeModel'],
          },
        ],
        {}
      )
    ).toEqual(
      expect.arrayContaining([`Reason required: ${inventory[0].id}`, `AWS signals changed: ${inventory[0].id}`])
    );
  });
});

describe('reviewed repository inventory', () => {
  it('every hosted declaration has a current reviewed disposition', () => {
    const paths = [...files('infra'), ...files('apps/workers/src/selfhost')].filter(
      file => /\.ts$/.test(file) && !/\.test\.ts$/.test(file) && !file.includes('/__tests__/')
    );
    const sourceFiles = Object.fromEntries(paths.map(file => [file, readFileSync(path.join(root, file), 'utf8')]));
    for (const entry of selfhostParityPolicy) {
      if (!entry.portable) continue;
      for (const dependency of portableImportCandidates(entry.portable.source, sourceFiles[entry.portable.source])) {
        for (const candidate of dependency.candidates) {
          try {
            sourceFiles[candidate] = readFileSync(path.join(root, candidate), 'utf8');
            break;
          } catch {
            /* Missing imports are reported by the guard. */
          }
        }
      }
    }
    const infra = Object.fromEntries(Object.entries(sourceFiles).filter(([file]) => file.startsWith('infra/')));
    for (const handler of discoverParityInventory(infra).flatMap(item => item.handlers)) {
      const file = handler.slice(0, handler.lastIndexOf('.')) + '.ts';
      try {
        sourceFiles[file] = readFileSync(path.join(root, file), 'utf8');
      } catch {
        /* Generated handlers may be unavailable in the open-core checkout. */
      }
    }
    const inventory = discoverParityInventory({
      ...infra,
      ...Object.fromEntries(Object.entries(sourceFiles).filter(([file]) => !file.startsWith('infra/'))),
    });
    expect(inventory.filter(item => item.kind === 'queue').length).toBeGreaterThan(50);
    expect(inventory.filter(item => item.kind === 'schedule').length).toBeGreaterThan(25);
    expect(inventory.filter(item => item.kind === 'event').length).toBeGreaterThan(5);
    expect(validateParityPolicy(inventory, selfhostParityPolicy, sourceFiles)).toEqual([]);
  });
});
