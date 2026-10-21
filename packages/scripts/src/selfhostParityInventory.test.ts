/**
 * Static wiring guard for self-host background parity. A 'portable' (wired) entry proves the
 * mapped local symbol exists and is reachable from the self-host entrypoint, not that it behaves
 * like the hosted handler: the mapping is a reviewed claim and fingerprints only detect change.
 * Gaps link to their capability's roadmap epic, not to a per-gap issue.
 *
 * Limitation: 'Gap now has local wiring' is detected only when a self-host file registers a
 * queue/schedule under the hosted literal name. A local registration under another name, or a
 * newly routed event, still relies on review.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NOT_COVERED,
  discoverParityInventory,
  portableRegistrationFingerprint,
  portableImportCandidates,
  validateParityPolicy,
} from './selfhostParityInventory';
import { selfhostParityPolicy } from './selfhostParityPolicy';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sources = (source: string) => ({ 'infra/test.ts': source });
const queue = "const jobs = new sst.aws.Queue('jobs', {}); jobs.subscribe({handler:'apps/workers/jobs.dispatch'});";
const MAIN = 'apps/workers/src/selfhost/main.ts';

function files(dir: string): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => {
    const name = `${dir}/${entry.name}`;
    return entry.isDirectory() ? files(name) : [name];
  });
}

const isErrnoException = (error: unknown): error is NodeJS.ErrnoException => error instanceof Error && 'code' in error;

/** Reads a repo file, or undefined when it does not exist. Any other read failure is rethrown. */
function readIfPresent(file: string): string | undefined {
  try {
    return readFileSync(path.join(root, file), 'utf8');
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
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

  it.each([
    "const jobs = enabled ? new aws.sqs.Queue('jobs', {}) : undefined;",
    "let jobs; if (enabled) jobs = new aws.sqs.Queue('jobs', {});",
  ])('resolves raw SQS subscriptions after conditional creation: %s', declaration => {
    const items = discoverParityInventory(
      sources(`${declaration} jobs.subscribe({handler:'apps/workers/jobs.dispatch'});`)
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'queue:infra/test.ts:jobs', handlers: ['apps/workers/jobs.dispatch'] });
  });

  it('fingerprints declared cadence helpers referenced by hosted schedules', () => {
    const before = "function cadence() { return 'rate(1 day)'; } new sst.aws.Cron('daily', {schedule:cadence()});";
    const after = before.replace('1 day', '2 days');
    expect(discoverParityInventory(sources(before))[0].fingerprint).not.toBe(
      discoverParityInventory(sources(after))[0].fingerprint
    );
  });

  it('fingerprints declared cadence helpers referenced by portable registrations', () => {
    const before =
      'function cadence() { return 4; } export function registerJobs(worker: Worker) { worker.registerDailyUtcTask("jobs", cadence(), dispatch); }';
    expect(portableRegistrationFingerprint(before, 'registerJobs')).not.toBe(
      portableRegistrationFingerprint(before.replace('return 4', 'return 5'), 'registerJobs')
    );
  });

  it('fingerprints imported declared cadence helpers', () => {
    const before = {
      'infra/cadence.ts': "export function cadence() { return 'rate(1 day)'; }",
      'infra/test.ts': "import {cadence} from './cadence'; new sst.aws.Cron('daily', {schedule:cadence()});",
    };
    const after = { ...before, 'infra/cadence.ts': before['infra/cadence.ts'].replace('1 day', '2 days') };
    expect(discoverParityInventory(before)[0].fingerprint).not.toBe(discoverParityInventory(after)[0].fingerprint);
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

describe('background trigger shapes', () => {
  it.each([
    [
      "const files = new sst.aws.Bucket('files'); files.notify({notifications:[{name:'created', function:{handler:'apps/workers/created.handler'}, events:['s3:ObjectCreated:*']}]});",
      'notification:infra/test.ts:files.created',
    ],
    [
      "const rule = new aws.cloudwatch.EventRule('rule', {eventPattern:'{}'}); new aws.cloudwatch.EventTarget('target', {rule: rule.name, arn:'topic'});",
      'eventRule:infra/test.ts:rule',
    ],
    ["new aws.ses.ReceiptRule('inbound', {ruleSetName:'set'});", 'sesRule:infra/test.ts:inbound'],
    [
      "const fn = new sst.aws.Function('logs', {handler:'apps/workers/logs.handler'}); new aws.cloudwatch.LogSubscriptionFilter('sub', {logGroup:'g', destinationArn: fn.arn, filterPattern:''});",
      'logSubscription:infra/test.ts:sub',
    ],
    [
      "new aws.sns.TopicSubscription('sub', {topic:'t', protocol:'email', endpoint:'ops'});",
      'snsSubscription:infra/test.ts:sub',
    ],
    [
      "const topic = new sst.aws.SnsTopic('alerts'); topic.subscribe({handler:'apps/workers/alert.handler'});",
      'snsSubscription:infra/test.ts:alerts',
    ],
    ["new sst.aws.Function('direct', {handler:'apps/workers/direct.handler'});", 'function:infra/test.ts:direct'],
    ["new sst.aws.Service('svc', {image:'registry/svc'});", 'service:infra/test.ts:svc'],
  ])('reports a newly added shape as unreviewed: %s', (source, id) => {
    const inventory = discoverParityInventory(sources(source));
    expect(inventory.map(item => item.id)).toEqual([id]);
    expect(validateParityPolicy(inventory, [], {})).toContain(`Unreviewed declaration: ${id}`);
  });

  it('inventories a trigger target Function under its trigger, not again on its own', () => {
    const [item, ...rest] = discoverParityInventory(
      sources(
        "const fn = new sst.aws.Function('upload', {handler:'apps/workers/upload.handler'}); const b = new sst.aws.Bucket('b'); b.notify({notifications:[{name:'up', function: fn.arn}]});"
      )
    );
    expect(rest).toEqual([]);
    expect(item).toMatchObject({ id: 'notification:infra/test.ts:b.up', handlers: ['apps/workers/upload.handler'] });
  });

  it('leaves HTTP Functions out and lists them as not covered', () => {
    expect(
      discoverParityInventory(sources("new sst.aws.Function('api', {handler:'apps/x.handler', url:true});"))
    ).toEqual([]);
    expect(NOT_COVERED.map(entry => entry.shape)).toContain('sst.aws.Function with a url option');
  });

  it('fails on a hosted constructor that is neither inventoried nor listed as not covered', () => {
    expect(() => discoverParityInventory(sources("new aws.sqs.NewTrigger('x', {});"))).toThrow(/unclassified/);
    expect(discoverParityInventory(sources("new aws.cloudwatch.MetricAlarm('alarm', {});"))).toEqual([]);
  });

  it('fails loudly on dynamic or unresolved new shapes', () => {
    expect(() => discoverParityInventory(sources('new aws.ses.ReceiptRule(name, {});'))).toThrow(/literal.*name/i);
    expect(() =>
      discoverParityInventory(sources("new aws.cloudwatch.EventTarget('t', {rule: missing.name, arn:'x'});"))
    ).toThrow(/unresolved EventTarget rule/);
    expect(() =>
      discoverParityInventory(sources("const b = new sst.aws.Bucket('b'); b.notify({notifications: list});"))
    ).toThrow(/literal notifications/);
    expect(() =>
      discoverParityInventory(sources("const bus = new sst.aws.Bus('bus'); bus.notify({notifications:[]});"))
    ).toThrow(/unsupported notify/);
    expect(() =>
      discoverParityInventory(
        sources("new aws.cloudwatch.LogSubscriptionFilter('s', {logGroup:'g', destinationArn: missing.arn});")
      )
    ).toThrow(/unresolved target/);
  });

  it('identifies a declaration built in a named factory by its site', () => {
    const [item] = discoverParityInventory(
      sources(
        'function subscribeAll(groups: string[]) { groups.forEach(group => new aws.cloudwatch.LogSubscriptionFilter(`sub-${group}`, {logGroup: group})); }'
      )
    );
    expect(item.id).toBe('logSubscription:infra/test.ts:subscribeAll()');
  });
});

describe('fingerprint scope', () => {
  const constants =
    "export const DEFAULT_ENV = { A: '1' }; export const RATE = 'rate(1 day)'; export const STAGES = ['production'];";
  const cron =
    "import {DEFAULT_ENV, RATE, STAGES} from './constants'; const LOCAL_ENV = { B: '1' }; new sst.aws.Cron('daily', {schedule: RATE, enabled: STAGES.includes($app.stage), function:{handler:'apps/workers/daily.handler', environment:{...DEFAULT_ENV, ...LOCAL_ENV}}});";
  const fingerprint = (constantsText: string, cronText = cron) =>
    discoverParityInventory({ 'infra/constants.ts': constantsText, 'infra/test.ts': cronText })[0].fingerprint;

  it('ignores an unrelated key added to a shared environment constant', () => {
    expect(fingerprint(constants.replace("A: '1'", "A: '1', NEW_KEY: 'x'"))).toBe(fingerprint(constants));
    expect(fingerprint(constants, cron.replace("B: '1'", "B: '1', NEW_KEY: 'x'"))).toBe(fingerprint(constants));
  });

  it('hashes only the accessed entry of an imported object constant', () => {
    const secrets = "export const secrets = { A: new sst.Secret('A', 'x'), B: new sst.Secret('B', 'x') };";
    const reader = (key: string) =>
      `import {secrets} from './secrets'; new sst.aws.Cron('daily', {schedule:'rate(1 day)', function:{handler:'apps/workers/daily.handler', link:[secrets.${key}]}});`;
    const print = (secretsText: string, key: string) =>
      discoverParityInventory({ 'infra/secrets.ts': secretsText, 'infra/test.ts': reader(key) })[0].fingerprint;
    const editedB = secrets.replace("'B', 'x'", "'B', 'y'");
    const added = secrets.replace(' };', ", C: new sst.Secret('C', 'x') };");
    expect(print(editedB, 'A')).toBe(print(secrets, 'A'));
    expect(print(added, 'A')).toBe(print(secrets, 'A'));
    expect(print(editedB, 'B')).not.toBe(print(secrets, 'B'));
  });

  it('still detects a changed referenced schedule, stage or in-place handler', () => {
    const base = fingerprint(constants);
    expect(fingerprint(constants.replace('1 day', '2 days'))).not.toBe(base);
    expect(fingerprint(constants.replace("['production']", "['production', 'dev']"))).not.toBe(base);
    expect(fingerprint(constants, cron.replace('daily.handler', 'weekly.handler'))).not.toBe(base);
  });
});

describe('local registration helpers and closed gaps', () => {
  const helperMain = (call: string) =>
    `async function main(){ const registerJobsQueue = (name: string, url: string) => { worker.registerQueueHandler(name, url, dispatch); }; ${call} } main();`;
  const inventory = () => discoverParityInventory(sources(queue));
  const local = (main: string) => ({ [MAIN]: main, 'apps/workers/jobs.ts': 'export function dispatch() {}' });

  it('maps a registration made through a local helper with a literal queue name', () => {
    const main = helperMain("registerJobsQueue('jobs', url);");
    const [item] = inventory();
    const policy = [
      {
        ...item,
        disposition: 'portable' as const,
        issue: 'Bike4Mind/bike4mind#2693',
        reason: 'Helper wiring',
        portable: {
          source: MAIN,
          symbol: 'queue:jobs',
          fingerprint: portableRegistrationFingerprint(main, 'queue:jobs')!,
        },
      },
    ];
    expect(validateParityPolicy([item], policy, local(main))).toEqual([]);
    expect(validateParityPolicy([item], policy, local(helperMain('')))).toContain(
      `Portable registration not reachable: ${item.id}`
    );
  });

  it('does not treat a helper that does not forward its first parameter as the name', () => {
    const main =
      "async function main(){ const register = (url: string, name: string) => worker.registerQueueHandler(name, url, dispatch); register('jobs', 'x'); } main();";
    expect(portableRegistrationFingerprint(main, 'queue:jobs')).toBeUndefined();
  });

  it('reports a gap whose hosted queue now has a matching local registration', () => {
    const [item] = inventory();
    const gap = { ...item, disposition: 'pending' as const, issue: 'Bike4Mind/bike4mind#2693', reason: 'Gap' };
    expect(validateParityPolicy([item], [gap], local(helperMain('')))).toEqual([]);
    expect(validateParityPolicy([item], [gap], local(helperMain("registerJobsQueue('jobs', url);")))).toContain(
      `Gap now has local wiring - review: ${item.id}: ${MAIN}`
    );
  });
});

describe('handler sources', () => {
  it('rejects a hosted handler whose source file is missing, naming declaration and path', () => {
    const inventory = discoverParityInventory(sources(queue));
    expect(inventory[0].handlerSources).toEqual([
      { handler: 'apps/workers/jobs.dispatch', file: 'apps/workers/jobs.ts', status: 'missing' },
    ]);
    expect(validateParityPolicy(inventory, [], {})).toContain(
      'Hosted handler source missing: queue:infra/test.ts:jobs: apps/workers/jobs.dispatch (expected apps/workers/jobs.ts; AWS import scan skipped)'
    );
  });

  it('distinguishes an absent overlay-generated handler explicitly instead of failing', () => {
    const inventory = discoverParityInventory(
      sources(
        "const jobs = new sst.aws.Queue('jobs', {}); jobs.subscribe({handler:'apps/client/server/premium-generated/jobs.dispatch'});"
      )
    );
    expect(inventory[0].handlerSources[0].status).toBe('overlayAbsent');
    expect(validateParityPolicy(inventory, [], {}).filter(error => error.startsWith('Hosted handler'))).toEqual([]);
  });

  it('treats only ENOENT as absence when reading repository sources', () => {
    expect(readIfPresent('infra/does-not-exist.ts')).toBeUndefined();
    expect(() => readIfPresent('infra')).toThrow(/EISDIR/);
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
        // Each specifier lists several extension candidates and at most one exists, so ENOENT on
        // the others is expected; an import with no candidate is reported by the guard.
        for (const candidate of dependency.candidates) {
          const text = readIfPresent(candidate);
          if (text === undefined) continue;
          sourceFiles[candidate] = text;
          break;
        }
      }
    }
    const infra = Object.fromEntries(Object.entries(sourceFiles).filter(([file]) => file.startsWith('infra/')));
    for (const { file } of discoverParityInventory(infra).flatMap(item => item.handlerSources)) {
      // Left absent on ENOENT: the guard then reports it as a missing handler, unless it is an
      // overlay-generated handler that an open-core checkout legitimately lacks.
      const text = readIfPresent(file);
      if (text !== undefined) sourceFiles[file] = text;
    }
    const inventory = discoverParityInventory({
      ...infra,
      ...Object.fromEntries(Object.entries(sourceFiles).filter(([file]) => !file.startsWith('infra/'))),
    });
    expect(inventory.filter(item => item.kind === 'queue').length).toBeGreaterThan(50);
    expect(inventory.filter(item => item.kind === 'schedule').length).toBeGreaterThan(25);
    expect(inventory.filter(item => item.kind === 'event').length).toBeGreaterThan(5);
    for (const kind of [
      'notification',
      'eventRule',
      'sesRule',
      'logSubscription',
      'snsSubscription',
      'function',
      'service',
    ])
      expect(
        inventory.some(item => item.kind === kind),
        kind
      ).toBe(true);
    expect(
      validateParityPolicy(inventory, selfhostParityPolicy, sourceFiles),
      'Review each record, then update packages/scripts/src/selfhostParityPolicy.ts; see SELF_HOST.md "Background capability inventory guard"'
    ).toEqual([]);
  });
});
