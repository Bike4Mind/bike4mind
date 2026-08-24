import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Every queue the application reads off `Resource` must exist in the self-host manifest.
 *
 * The shim throws a clear, self-describing error for an unregistered key, so this is not
 * guarding against silence in general - it is guarding against WHERE that throw lands. A queue
 * is usually read by a PRODUCER, and a producer often enqueues as its last step, after it has
 * already written rows. Issue #2018 is the worked example: /api/data-lakes/drive-sync creates
 * the connection row and takes a globally-unique driveFolderId claim, and only then reads
 * `Resource.driveLakeIngestQueue`. The throw leaves a folder that reads "Connected" and will
 * never sync, and the claim had to be released by hand.
 *
 * Moving that discovery from a user request to this test is the whole point. Registering a
 * missing queue takes one line; finding out from a half-committed row does not.
 */

const REPO_ROOT = join(__dirname, '../../..');
const MANIFEST = join(__dirname, 'manifest.ts');

/**
 * Queue names the application resolves, by ANY mechanism, in shippable (non-test) code.
 *
 * There are three, and each one this guard did not know about had already hidden a real gap:
 *   1. the property path `Resource.fooQueue.url`;
 *   2. the string path `getSourceQueueUrl('fooQueue')`, which reads the `sourceQueueUrls`
 *      name-to-URL Linkable instead - invisible to a search for `Resource.*Queue`, and the form
 *      the API routes mostly use, so the first version of this test declared sreJobQueue
 *      "unreachable on self-host" while two admin routes were resolving it by name;
 *   3. the cast path `(Resource as any).fooQueue.url`, where the matched text starts
 *      `Resource as any).fooQueue` so a bare `Resource\.` never matches. That one hid
 *      webhookDeliveryQueue, which shippable code reads and no list accounted for.
 *
 * `Resource['fooQueue']` is not used anywhere, so it is deliberately not covered.
 */
const referencedQueues = (): Map<string, string[]> => {
  let out = '';
  try {
    out = execFileSync(
      'grep',
      [
        '-rnoE',
        "Resource( as [A-Za-z][A-Za-z0-9]*\\))?(\\?)?\\.[A-Za-z][A-Za-z0-9]*Queue|getSourceQueueUrl\\('[A-Za-z][A-Za-z0-9]*'\\)",
        'apps/client/server',
        'apps/client/pages',
        'b4m-core',
        // Dev scripts resolve queues off Resource too. In scope on purpose: a queue whose only
        // read lives here would otherwise be invisible, and the sanity check below cannot see
        // the difference because it only asserts the map is non-empty.
        'packages',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    );
  } catch (e) {
    // grep exits 1 for no matches and 2 for a real failure (missing path, unreadable file).
    // Collapsing both to an empty scan would report "no queues referenced" for a broken run,
    // so only the no-match case is tolerated here.
    if ((e as { status?: number }).status !== 1) throw e;
  }

  const found = new Map<string, string[]>();
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [, , expr] = line.split(/:(\d+):/);
    const file = line.slice(0, line.indexOf(':'));
    if (/\.test\.|__tests__|\/dist\//.test(file)) continue;
    const raw = expr ?? line;
    // Either `Resource.fooQueue` or `getSourceQueueUrl('fooQueue')`.
    const key = raw.includes("'") ? raw.split("'")[1] : raw.split('.').pop()!;
    found.set(key, [...(found.get(key) ?? []), file]);
  }
  return found;
};

/**
 * Queues whose PRODUCER cannot run on self-host at all, so registering them would be dead
 * config. A reason is mandatory and it is a claim about reachability that someone checked.
 *
 * Note how short this list is. It held sreJobQueue until the guard learned about the string
 * resolution path and found two admin routes resolving it by name - the "unreachable" claim was
 * simply wrong. Reachability is easy to get wrong from one grep; prefer the list below.
 */
const UNREACHABLE_ON_SELF_HOST: Record<string, string> = {
  // Handler lives in the premium overlay (premium-generated/), so open core has nothing to run
  // it with. The route exists here, which means it fails on self-host - but declaring the queue
  // would not fix that, it would just move the failure.
  overwatchAnalyticsQueue: 'premium overlay handler; open core cannot consume it',
};

/**
 * Reachable on self-host, NOT yet wired, decision pending. Distinct from the list above on
 * purpose: these are real gaps with a named owner-decision, not architectural impossibilities.
 * Every entry says who can reach it and what it needs, so the next person is choosing rather
 * than rediscovering. Emptying this list is the goal; growing it needs a reason.
 */
const PENDING_SCOPE_DECISION: Record<string, string> = {
  // Self-host generates images through a local backend (IMAGE_GEN_BASE_URL) and the tools gate
  // themselves off via isLocalImageBackendAvailable, so nothing enqueues today. Wiring the
  // hosted queue path would be the wrong fix rather than a missing one.
  imageGenerationQueue: 'feature gated off upstream; self-host uses a local image backend',
  imageEditQueue: 'feature gated off upstream; self-host uses a local image backend',
  videoGenerationQueue: 'no self-host video path at all yet',

  // User-facing, handler in open core, no AWS-only dependency. These are the strongest
  // candidates to wire next.
  questExportQueue: 'reachable from /api/quest-plans/[id]/export - candidate to wire',
  slackExportQueue: 'reachable from /api/slack/export/async - candidate to wire',
  dataLakeCleanupQueue: 'reachable from /api/data-lakes/[id]/lifecycle - candidate to wire',
  githubWebhookQueue: 'reachable from /api/webhooks/github/[token] - candidate to wire',

  // Surfaced by teaching the scanner the cast form. Read at two admin routes (webhook delivery
  // retry, and GitHub replay-dlq) and its handler IS in open core, so this is a real gap rather
  // than an impossibility. Not registered here on purpose: nothing consumes it on self-host yet,
  // and a declared queue with no consumer accepts messages forever and drops them silently,
  // which is worse than the clean 503 both call sites already degrade to.
  webhookDeliveryQueue: 'reachable from the webhook retry and replay-dlq routes - needs a consumer first',

  // Admin-only, and each needs something self-host has not got.
  whatsNewGenerationQueue: 'admin-only backfill route; needs a content-generation decision',
  secopsTriageQueue: 'admin security-dashboard ingest; needs Prowler and AWS findings',
  sreJobQueue: 'admin SRE rerun/retry routes; handler needs Bedrock and CloudWatch',
};

const manifestKeys = (): Set<string> =>
  new Set([...readFileSync(MANIFEST, 'utf8').matchAll(/^ {2}([A-Za-z0-9_]+):/gm)].map(m => m[1]));

describe('self-host resource manifest coverage', () => {
  it('finds queue references at all', () => {
    // Parser sanity. A regex that silently matched nothing would make the real assertion below
    // pass vacuously, which is how the first version of the queue-coverage guard failed.
    const refs = referencedQueues();
    expect(refs.size).toBeGreaterThan(5);
    expect([...refs.keys()]).toContain('fabFileChunkQueue');
  });

  it('registers every queue the application reads off Resource', () => {
    const declared = manifestKeys();
    const missing = [...referencedQueues().entries()]
      .filter(([key]) => !declared.has(key) && !(key in UNREACHABLE_ON_SELF_HOST) && !(key in PENDING_SCOPE_DECISION))
      .map(([key, files]) => `${key} (read in ${files[0]})`);

    expect(missing, `queues read off Resource but absent from the manifest:\n  ${missing.join('\n  ')}`).toEqual([]);
  });

  it('does not exempt a queue that is also registered', () => {
    // Both would mean the reachability claim is stale: it IS wired, so the exemption is a lie
    // that would hide the next genuinely unreachable one.
    const declared = manifestKeys();
    const both = [...Object.keys(UNREACHABLE_ON_SELF_HOST), ...Object.keys(PENDING_SCOPE_DECISION)].filter(k =>
      declared.has(k)
    );
    expect(both, `exempted as unreachable yet registered: ${both.join(', ')}`).toEqual([]);
  });

  it('does not exempt a queue nothing references any more', () => {
    const referenced = new Set(referencedQueues().keys());
    const stale = [...Object.keys(UNREACHABLE_ON_SELF_HOST), ...Object.keys(PENDING_SCOPE_DECISION)].filter(
      k => !referenced.has(k)
    );
    expect(stale, `exempted but no longer read anywhere: ${stale.join(', ')}`).toEqual([]);
  });
});
