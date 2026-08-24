import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { DEFAULT_MANIFEST } from './manifest';

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

/**
 * Where shippable code lives. `packages` is enumerated rather than taken whole: `packages/*` is a
 * live pnpm workspace glob in EVERY checkout and `packages/premium/<name>` is hydrated by the
 * deploy pipeline, so scanning it would make this test pass in CI (never hydrated) and fail on a
 * developer machine that has the overlay. Optional packages are out of scope for the manifest by
 * the same reasoning index.test.ts gives for tavernHeartbeatQueue: open core cannot consume them.
 */
const SCAN_ROOTS = [
  'apps/client/server',
  'apps/client/pages',
  'b4m-core',
  'packages/cli',
  'packages/database',
  'packages/scripts',
];

/** Reads off `Resource`, including through a cast of any width and across a line break. */
const RESOURCE_READ = /Resource(?:\s+as\s+[^)]*\))?\s*\??\s*\.\s*([A-Za-z][A-Za-z0-9]*Queue)(?![A-Za-z0-9])/g;
/** The string path: getSourceQueueUrl('fooQueue'). */
const BY_NAME = /getSourceQueueUrl\(\s*'([A-Za-z][A-Za-z0-9]*)'\s*\)/g;
/** dlqRegistry's own table of queue names - see the second-source note below. */
const DLQ_SOURCE_QUEUE = /sourceQueue:\s*'([A-Za-z][A-Za-z0-9]*)'/g;

/** Directories never worth descending into. PRUNED during the walk rather than filtered after:
 *  `readdirSync(recursive)` descends into node_modules before any filter can run, which took the
 *  scan from milliseconds to ~17s per assertion and timed the suite out in CI. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '__tests__', '.git', '.turbo']);

const shippableFiles = (): string[] => {
  const out: string[] = [];
  const walk = (absDir: string, relDir: string): void => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(join(absDir, entry.name), rel);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) {
        out.push(rel);
      }
    }
  };
  for (const root of SCAN_ROOTS) {
    const abs = join(REPO_ROOT, root);
    if (existsSync(abs)) walk(abs, root);
  }
  return out;
};

/**
 * Queue names the application resolves in shippable (non-test) code.
 *
 * Scans file CONTENT rather than shelling out to grep, because grep is line-oriented and a
 * wrapped access - `(Resource as unknown as Record<...>)` on one line, `.fooQueue` on the next -
 * carries no `Resource` token on the line that names the queue. That is not hypothetical: it is
 * how whatsNewHighlightsQueue stayed invisible after the cast form was already handled.
 *
 * Two independent sources, deliberately. Every previous round of this guard was defeated by one
 * more syntactic form nobody had enumerated (the string path, then `as any`, then a wide cast,
 * then a line break), and a regex cannot be robust to syntax it has never seen. dlqRegistry.ts
 * carries an authoritative table of queue names as `sourceQueue: '<name>'` literals in one stable
 * shape, so it catches a queue however its call site happens to be written. It is a SECOND source,
 * not a replacement: it only covers queues that have a DLQ.
 */
const referencedQueues = (): Map<string, string[]> => {
  const found = new Map<string, string[]>();
  const add = (key: string, file: string) => found.set(key, [...(found.get(key) ?? []), file]);

  for (const file of shippableFiles()) {
    const content = readFileSync(join(REPO_ROOT, file), 'utf8');
    for (const re of [RESOURCE_READ, BY_NAME]) {
      re.lastIndex = 0;
      for (const m of content.matchAll(re)) add(m[1], file);
    }
    if (file.endsWith('dlqRegistry.ts')) {
      for (const m of content.matchAll(DLQ_SOURCE_QUEUE)) add(m[1], file);
    }
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
  // Surfaced by the dlqRegistry second source, which sees a queue however its call site is
  // written. Same disposition as above and it must stay that way: these are premium overlay
  // queues and declaring them in the open-core manifest would be wrong, not merely unnecessary.
  // They are listed here (not registered) precisely so that stays a stated decision.
  tavernHeartbeatQueue: 'premium overlay (b4m-tavern) handler; open core cannot consume it',
  optihashiRunCompletionQueue: 'premium overlay handler; open core cannot consume it',
  bobRunQueue: 'premium overlay handler; open core cannot consume it',
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
  // Same feature family, surfaced once the scanner learned to read a wide cast and a wrapped
  // access. Worth noting for whoever wires it: the 500 guard at generate-highlights.ts cannot
  // fire on self-host, because the shim's Proxy throws on the property access before `?.url` is
  // ever evaluated. The cron site degrades to a logged error instead.
  whatsNewHighlightsQueue: 'admin route + highlights cron; needs the same content-generation decision',
  secopsTriageQueue: 'admin security-dashboard ingest; needs Prowler and AWS findings',
  sreJobQueue: 'admin SRE rerun/retry routes; handler needs Bedrock and CloudWatch',
};

/**
 * Registered QUEUES, imported and filtered on kind rather than parsed out of the source text.
 * Text-matching every `  name:` line admitted all 88 manifest entries of every kind, so a queue
 * mistyped as `{ kind: 'secret' }` would satisfy this check AND drop out of the three consistency
 * checks in index.test.ts, leaving it absent from elasticmq.conf and the env template with nothing
 * complaining - while the shim handed its call site `{ value }` instead of `{ url }`.
 */
const manifestKeys = (): Set<string> =>
  new Set(
    Object.entries(DEFAULT_MANIFEST)
      .filter(([, entry]) => (entry as { kind: string }).kind === 'queue')
      .map(([name]) => name)
  );

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
