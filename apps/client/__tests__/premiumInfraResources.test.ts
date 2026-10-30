import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Runs the real codegen in a sandbox tree (its paths derive from its own location) and
// checks the infra-resource glue: one literal, written to the deploy side and the runtime
// side alike, with or without an overlay, linked or not.

const REAL_SCRIPT = join(__dirname, '../scripts/generate-premium-glue.mjs');
const TARGETS = [
  'infra/premium-generated/infraResources.generated.ts',
  'packages/server-utils/src/premium-generated/infraResources.generated.ts',
];

let sandbox: string;

function runCodegen() {
  const script = join(sandbox, 'apps/client/scripts/generate-premium-glue.mjs');
  return spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, CI: '' } });
}

function readTargets() {
  return TARGETS.map(t => readFileSync(join(sandbox, t), 'utf8'));
}

function writeOverlay(infraResources: unknown) {
  const dir = join(sandbox, 'packages/premium/fakeoverlay');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: '@bike4mind/premium-fakeoverlay', b4mContributions: { infraResources } })
  );
}

const QUEUE = {
  name: 'exampleJobQueue',
  visibilityTimeout: '6 minutes',
  label: 'example-job',
  displayName: 'Example Job',
  application: 'Example',
};

const ROTATION = {
  secret: 'EXAMPLE_API_TOKEN',
  description: 'Example token',
  rotationIntervalDays: 90,
  isAutomatic: false,
  rotationProcess: 'Rotate upstream, then sst secret set',
};

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'infra-fixture-'));
  mkdirSync(join(sandbox, 'apps/client/scripts'), { recursive: true });
  mkdirSync(join(sandbox, 'apps/client/pages/api'), { recursive: true });
  cpSync(REAL_SCRIPT, join(sandbox, 'apps/client/scripts/generate-premium-glue.mjs'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('infra resource glue', () => {
  it('emits empty lists to both targets with no overlay', () => {
    expect(runCodegen().status).toBe(0);
    const [infra, runtime] = readTargets();
    expect(infra).toBe(runtime);
    expect(infra).toContain('"secrets": []');
    expect(infra).toContain('"rotations": []');
    expect(infra).toContain('"queues": []');
  });

  it('copies a declared queue pair to both targets, dropping undeclared optional fields', () => {
    writeOverlay({ queues: [{ ...QUEUE, retry: 5, tags: { Team: 'x' }, extra: 'evil' }] });
    const result = runCodegen();
    expect(result.status, result.stderr).toBe(0);
    const [infra, runtime] = readTargets();
    expect(infra).toBe(runtime);
    expect(infra).toContain('"name": "exampleJobQueue"');
    expect(infra).toContain('"label": "example-job"');
    expect(infra).toContain('"retry": 5');
    expect(infra).not.toContain('dlqName');
    expect(infra).not.toContain('evil');
  });

  it('emits the same declared data to both targets, even for an unlinked overlay', () => {
    writeOverlay({ secrets: [{ name: 'EXAMPLE_API_TOKEN', env: true }], rotations: [ROTATION] });
    const result = runCodegen();
    expect(result.status, result.stderr).toBe(0);
    const [infra, runtime] = readTargets();
    expect(infra).toBe(runtime);
    expect(infra).toContain('"name": "EXAMPLE_API_TOKEN"');
    expect(infra).toContain('"env": true');
    expect(infra).toContain('"rotationIntervalDays": 90');
    // Data only: the overlay package itself is never imported.
    expect(infra).not.toContain('premium-fakeoverlay');
  });

  it('drops fields it does not know rather than copying them into the literal', () => {
    writeOverlay({ secrets: [{ name: 'EXAMPLE_API_TOKEN', extra: "'); evil();" }] });
    expect(runCodegen().status).toBe(0);
    expect(readTargets()[0]).not.toContain('evil');
  });

  it.each([
    ['a non-object', 'nope'],
    ['a non-array secrets list', { secrets: {} }],
    ['a null secrets list', { secrets: null }],
    ['a null rotations list', { rotations: null }],
    ['a non-string secret name', { secrets: [{ name: 1 }] }],
    ['a non-boolean env flag', { secrets: [{ name: 'A', env: 'yes' }] }],
    ['a single-character Lambda env key', { secrets: [{ name: 'A', env: true }] }],
    ['a non-positive rotation interval', { rotations: [{ ...ROTATION, rotationIntervalDays: 0 }] }],
    ['a rotation interval past the admin limit', { rotations: [{ ...ROTATION, rotationIntervalDays: 366 }] }],
    ['an unrepresentable rotation date', { rotations: [{ ...ROTATION, rotationIntervalDays: 1e308 }] }],
    ['a non-array queues list', { queues: {} }],
    ['a queue without a label', { queues: [{ ...QUEUE, label: undefined }] }],
    ['a queue with a non-string visibility timeout', { queues: [{ ...QUEUE, visibilityTimeout: 360 }] }],
    ['a queue with a negative retry', { queues: [{ ...QUEUE, retry: -1 }] }],
    ['a queue with an unknown encryption', { queues: [{ ...QUEUE, encryption: 'aes' }] }],
    ['a queue with non-string tags', { queues: [{ ...QUEUE, tags: { Team: 1 } }] }],
  ])('fails codegen on %s', (_label, value) => {
    writeOverlay(value);
    const result = runCodegen();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('b4mContributions.infraResources');
  });

  it.each([{ name: 'A' }, { name: 'A', env: false }, { name: 'AB', env: true }])(
    'accepts a secret with a valid env option: %j',
    secret => {
      writeOverlay({ secrets: [secret] });
      const result = runCodegen();
      expect(result.status, result.stderr).toBe(0);
      expect(readTargets()[0]).toContain(`"name": "${secret.name}"`);
    }
  );

  it('lists every core resource name infra/ declares', () => {
    mkdirSync(join(sandbox, 'infra'), { recursive: true });
    writeFileSync(
      join(sandbox, 'infra/secrets.ts'),
      "export const secrets = {\n  A: new sst.Secret('CORE_A', 'x'),\n  B: new sst.Secret(\n    'CORE_B',\n    'y'\n  ),\n};\n"
    );
    writeFileSync(join(sandbox, 'infra/web.ts'), "export const web = new sst.aws.Nextjs('Web', {});\n");
    expect(runCodegen().status).toBe(0);
    expect(readTargets()[1]).toContain('coreResourceNames: readonly string[] | null = ["App","CORE_A","CORE_B","Web"]');
  });

  it('lists the DLQ labels infra/dlqAlarms.ts alarms on, and accepts the contributed queue loop', () => {
    mkdirSync(join(sandbox, 'infra'), { recursive: true });
    writeFileSync(join(sandbox, 'infra/secrets.ts'), "export const s = new sst.Secret('CORE_A', 'x');\n");
    writeFileSync(
      join(sandbox, 'infra/dlqAlarms.ts'),
      "const D = [{ label: 'image-generation' }];\ncreateDlqAlarms({ label: 'fab-file-moderation' });\n" +
        "widget({ label: 'Messages Visible' });\n"
    );
    writeFileSync(
      join(sandbox, 'infra/queues.ts'),
      "const q = new sst.aws.Queue('coreQueue', {});\n" +
        'const dlq = new sst.aws.Queue(pair.dlqName, pair.dlqArgs);\n' +
        'const queue = new sst.aws.Queue(pair.name, pair.queueArgs(dlq.arn));\n'
    );
    const result = runCodegen();
    expect(result.status, result.stderr).toBe(0);
    const runtime = readTargets()[1];
    expect(runtime).toContain('coreDlqLabels: readonly string[] | null = ["fab-file-moderation","image-generation"]');
    expect(runtime).toContain('"coreQueue"');
  });

  it('fails codegen on a DLQ label that is not a literal, other than the contributed spec.label', () => {
    mkdirSync(join(sandbox, 'infra'), { recursive: true });
    writeFileSync(join(sandbox, 'infra/secrets.ts'), "export const s = new sst.Secret('CORE_A', 'x');\n");
    const alarms =
      "const D = [{ label: 'image-generation' }];\nconst C = specs.map(spec => ({ label: spec.label }));\n";
    writeFileSync(join(sandbox, 'infra/dlqAlarms.ts'), alarms);
    expect(runCodegen().status).toBe(0);
    writeFileSync(join(sandbox, 'infra/dlqAlarms.ts'), `${alarms}createDlqAlarms({ label: coreLabel });\n`);
    const result = runCodegen();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('not written as a string literal: coreLabel');
  });

  it('exempts one contributed queue loop and one spec.label, not a second of either', () => {
    mkdirSync(join(sandbox, 'infra'), { recursive: true });
    writeFileSync(join(sandbox, 'infra/secrets.ts'), "export const s = new sst.Secret('CORE_A', 'x');\n");
    const loop = 'const queue = new sst.aws.Queue(pair.name, pair.queueArgs(dlq.arn));\n';
    writeFileSync(join(sandbox, 'infra/queues.ts'), loop + loop);
    const queues = runCodegen();
    expect(queues.status).not.toBe(0);
    expect(queues.stderr).toContain('infra/queues.ts: 1 sst constructor(s) not named');
    writeFileSync(join(sandbox, 'infra/queues.ts'), loop);
    writeFileSync(join(sandbox, 'infra/dlqAlarms.ts'), 'const C = [{ label: spec.label }, { label: spec.label }];\n');
    const labels = runCodegen();
    expect(labels.status).not.toBe(0);
    expect(labels.stderr).toContain('not written as a string literal: spec.label');
  });

  it('reads a core DLQ label in either quote style', () => {
    mkdirSync(join(sandbox, 'infra'), { recursive: true });
    writeFileSync(join(sandbox, 'infra/secrets.ts'), "export const s = new sst.Secret('CORE_A', 'x');\n");
    writeFileSync(
      join(sandbox, 'infra/dlqAlarms.ts'),
      'const D = [{ label: "double-quoted" }, { label: \'single-quoted\' }];\n'
    );
    const result = runCodegen();
    expect(result.status, result.stderr).toBe(0);
    expect(readTargets()[1]).toContain('coreDlqLabels: readonly string[] | null = ["double-quoted","single-quoted"]');
  });

  it('emits null core names without infra/, so the runtime registers nothing', () => {
    writeOverlay({ secrets: [{ name: 'EXAMPLE_API_TOKEN' }] });
    expect(runCodegen().status).toBe(0);
    const [infra, runtime] = readTargets();
    expect(infra).toBe(runtime);
    expect(runtime).toContain('coreResourceNames: readonly string[] | null = null');
    expect(runtime).toContain('coreEnvNames: readonly string[] | null = null');
    expect(runtime).toContain('coreDlqLabels: readonly string[] | null = null');
  });

  it('lists the env form of core resources and the env keys infra defines, not env example keys', () => {
    mkdirSync(join(sandbox, 'infra'), { recursive: true });
    writeFileSync(join(sandbox, 'infra/secrets.ts'), "export const s = new sst.Secret('CORE_A', 'x');\n");
    writeFileSync(
      join(sandbox, 'infra/chat.ts'),
      "export const c = new sst.aws.Service('ChatCompletion', {\n  environment: {\n    SERVER_DOMAIN: 'x',\n    ...(on ? { ORIGIN_SECRET: 'y' } : {}),\n  },\n});\n"
    );
    writeFileSync(join(sandbox, '.env.selfhost.example'), 'INTERNAL_WS_SECRET=changeme\n# MAIL_HOST=smtp\n');
    expect(runCodegen().status).toBe(0);
    const [infra, runtime] = readTargets();
    expect(infra).toBe(runtime);
    const match = /coreEnvNames: readonly string\[\] \| null = (\[.*\]);/.exec(runtime);
    const names: string[] = JSON.parse(match![1]);
    expect(names).toEqual(expect.arrayContaining(['CHAT_COMPLETION', 'CORE_A', 'SERVER_DOMAIN', 'ORIGIN_SECRET']));
    expect(names).not.toContain('INTERNAL_WS_SECRET');
    expect(names).toEqual([...names].sort());
  });

  it('fails codegen when a core component is not named by a single-quoted literal', () => {
    mkdirSync(join(sandbox, 'infra'), { recursive: true });
    writeFileSync(join(sandbox, 'infra/secrets.ts'), "export const s = new sst.Secret('CORE_A', 'x');\n");
    writeFileSync(join(sandbox, 'infra/web.ts'), 'export const w = new sst.aws.Nextjs(`Web${stage}`, {});\n');
    const result = runCodegen();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('single-quoted literal');
  });

  it('leaves unchanged files alone on a second run', () => {
    writeOverlay({ secrets: [{ name: 'EXAMPLE_API_TOKEN' }] });
    expect(runCodegen().status).toBe(0);
    const second = runCodegen();
    for (const target of TARGETS) expect(second.stdout).toContain(`unchanged ${target}`);
  });
});
