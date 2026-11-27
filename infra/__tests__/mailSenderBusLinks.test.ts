/**
 * @vitest-environment node
 *
 * Mail leaves every process but the email-send worker as an email.send event (queuedMailer in
 * packages/server-utils/src/utils/mailer/queuedMailer.ts reads Resource.AppEventBus.name), so each
 * compute that can send a notice has to link eventBus. Without the link the publish throws, the
 * mailer resolves false, and the notice is not sent on any deployed stage. Handler unit tests mock
 * the publish, so only this guard catches a missing link.
 *
 * The list is kept by hand: add the compute here when a new handler reaches queuedMailer.
 * Text-matched, not executed: infra/ is an SST program and does not load outside `sst`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Strip comments so a commented-out entry cannot satisfy the assertions below.
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const readRepo = (file: string) => stripComments(readFileSync(path.join(REPO_ROOT, file), 'utf8'));

/** The first `link: [...]` after the marker, which is the link of the compute the marker opens. */
const linkAfter = (file: string, marker: string) => {
  const source = readRepo(file);
  const from = source.indexOf(marker);
  expect(from, `${marker} not found in ${file}`).toBeGreaterThanOrEqual(0);
  return /\blink: \[([^\]]*)\]/.exec(source.slice(from))?.[1] ?? '';
};

/** The source from the marker up to the next compute constructor, i.e. that compute's own options. */
const blockAfter = (file: string, marker: string) => {
  const source = readRepo(file);
  const from = source.indexOf(marker);
  expect(from, `${marker} not found in ${file}`).toBeGreaterThanOrEqual(0);
  const rest = source.slice(from + marker.length);
  const next = rest.search(/new sst\.aws\.|\.subscribe\(|\.notify\(/);
  return next === -1 ? rest : rest.slice(0, next);
};

// Built from parts so the infra handler scan in packages/scripts does not read it as a handler path.
const WORKERS_SRC = ['apps', 'workers', 'src'].join('/');
const worker = (handler: string) => `handler: '${WORKERS_SRC}/${handler}'`;

const MAIL_SENDING_COMPUTE: { file: string; marker: string; sends: string }[] = [
  { file: 'infra/web.ts', marker: 'new sst.aws.Nextjs(', sends: 'account, key, data lake and admin test notices' },
  { file: 'infra/emailMarketing.ts', marker: worker('queueHandlers/emailBatch.dispatch'), sends: 'email jobs' },
  { file: 'infra/queues.ts', marker: worker('queueHandlers/fabFileVectorize.dispatch'), sends: 'spend notices' },
  // Everything below records image moderation incidents, which alert the reviewers by mail.
  {
    file: 'infra/imageModerationReviewSweep.ts',
    marker: worker('cron/imageModerationReviewSweep.handler'),
    sends: 'alerts',
  },
  { file: 'infra/queues.ts', marker: worker('s3/objectCreated.func'), sends: 'alerts' },
  { file: 'infra/queues.ts', marker: worker('deepAgent/wakeHandler.dispatch'), sends: 'alerts' },
  { file: 'infra/queues.ts', marker: worker('queueHandlers/imageGeneration.dispatch'), sends: 'alerts' },
  { file: 'infra/queues.ts', marker: worker('queueHandlers/imageEdit.dispatch'), sends: 'alerts' },
  { file: 'infra/queues.ts', marker: worker('queueHandlers/agentProactiveMessage.dispatch'), sends: 'alerts' },
  { file: 'infra/queues.ts', marker: worker('queueHandlers/generationJob.dispatch'), sends: 'alerts' },
  { file: 'infra/cron.ts', marker: worker('cron/dataLakeBatchReconcile.handler'), sends: 'alerts' },
  { file: 'infra/cron.ts', marker: worker('cron/apiKeyExpiryReminder.handler'), sends: 'key expiry reminders' },
  { file: 'infra/buckets.ts', marker: worker('s3/notebookImportComplete.dispatch'), sends: 'alerts' },
  { file: 'infra/functions.ts', marker: worker('queueHandlers/slackQuestProcessor.handler'), sends: 'alerts' },
  { file: 'infra/agentExecutor.ts', marker: worker('queueHandlers/agentExecutor.handler'), sends: 'alerts' },
  { file: 'infra/chatCompletion.ts', marker: "new sst.aws.Service('ChatCompletion'", sends: 'alerts' },
  // Runs chat completions through the Slack package, whose defaults record incidents.
  { file: 'infra/llm.ts', marker: worker('events/slackQuickAsk.handler'), sends: 'alerts' },
];

describe('computes that queue mail link the event bus', () => {
  it.each(MAIL_SENDING_COMPUTE)('$marker in $file links eventBus', ({ file, marker }) => {
    expect(linkAfter(file, marker)).toMatch(/\beventBus\b/);
  });

  // queuedMailer offloads an over-limit body to the app files bucket before publishing.
  it.each(MAIL_SENDING_COMPUTE)('$marker in $file can write offloaded mail bodies', ({ file, marker }) => {
    const block = blockAfter(file, marker);
    expect(block).toContain('mailBodyEnvironment(appFilesBucket)');
    expect(block).toContain('mailBodyPutPermission(appFilesBucket)');
  });

  it('reads a link that lacks the bus as not linked', () => {
    // Pins the matcher: the push notification subscriber has a link and no bus in it.
    const link = linkAfter('infra/eventBus.ts', worker('events/sendPush.handler'));
    expect(link).toContain('allSecrets');
    expect(link).not.toMatch(/\beventBus\b/);
  });
});
