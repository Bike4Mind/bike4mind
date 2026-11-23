/**
 * @vitest-environment node
 *
 * Text-matched like mailSenderBusLinks.test.ts: infra/ is an SST program and does not load outside `sst`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const readRepo = (file: string) => stripComments(readFileSync(path.join(REPO_ROOT, file), 'utf8'));

const prefixIn = (file: string) => /MAIL_BODY_PREFIX = '([^']+)'/.exec(readRepo(file))?.[1];

const workerBlock = () => {
  const source = readRepo('infra/eventBus.ts');
  const from = source.indexOf(`handler: '${['apps', 'workers', 'src'].join('/')}/events/sendEmail.handler'`);
  expect(from).toBeGreaterThanOrEqual(0);
  const rest = source.slice(from);
  return rest.slice(0, rest.indexOf('detailType'));
};

describe('offloaded mail bodies', () => {
  it('uses the same prefix in infra and in the mailer', () => {
    const infraPrefix = prefixIn('infra/mailBodyOffload.ts');
    expect(infraPrefix).toBe('queued-mail/');
    expect(prefixIn('packages/server-utils/src/utils/mailer/mailBodyStore.ts')).toBe(infraPrefix);
  });

  it('grants objects under the prefix only, put and get separately', () => {
    const source = readRepo('infra/mailBodyOffload.ts');
    expect(source).toContain("actions: ['s3:PutObject']");
    expect(source).toContain("actions: ['s3:GetObject']");
    expect(source.match(/\$\{bucket\.arn\}\/\$\{MAIL_BODY_PREFIX\}\*/g)).toHaveLength(2);
    expect(source).not.toMatch(/s3:\*|s3:DeleteObject/);
  });

  it('lets the email-send worker read the prefix without linking the bucket', () => {
    const block = workerBlock();
    expect(block).toContain('mailBodyGetPermission(appFilesBucket)');
    expect(block).toContain('mailBodyEnvironment(appFilesBucket)');
    expect(block).not.toContain('mailBodyPutPermission');
    const link = /\blink: \[([^\]]*)\]/.exec(block)?.[1] ?? '';
    expect(link).not.toMatch(/\bappFilesBucket\b/);
  });

  it('expires the prefix after a day', () => {
    const source = readRepo('infra/buckets.ts');
    const rule = source.slice(source.indexOf("id: 'expire-queued-mail'"));
    expect(rule.length).toBeLessThan(source.length);
    const body = rule.slice(0, rule.indexOf('\n    },\n'));
    expect(body).toContain('prefix: MAIL_BODY_PREFIX');
    expect(body).toMatch(/expiration: \{\s*days: 1,/);
  });
});
