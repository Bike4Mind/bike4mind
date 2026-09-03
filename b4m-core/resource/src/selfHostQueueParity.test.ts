import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MANIFEST } from './manifest';

/**
 * Pins the three hand-maintained self-host queue lists to each other.
 *
 * A self-host queue only works when all three agree, and each disagreement fails differently
 * and late:
 *   - `.env.selfhost.example` gives the enqueue side its URL (via the shim's `queueUrls` proxy).
 *     Missing -> `getSourceQueueUrl` throws at enqueue time.
 *   - `elasticmq.conf` predeclares the queue. Missing -> the URL resolves but points at nothing,
 *     so sends fail against a nonexistent queue.
 *   - the manifest entry is what a consumer reads (`Resource.<name>Queue.url`). Missing ->
 *     `Resource.<name>` throws "not registered in the self-host manifest".
 *
 * #2174 was exactly this class of gap: imageGenerationQueue was absent from all three, so image
 * generation could not run locally at all and nothing said so. Text-matched rather than
 * HOCON-parsed on purpose - the repo has no HOCON parser, and the queue block is a flat list of
 * `name { }` lines.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Queue names declared in the `queues { ... }` block of elasticmq.conf. */
function elasticMqQueueNames(): string[] {
  const contents = fs.readFileSync(path.join(REPO_ROOT, 'elasticmq.conf'), 'utf8');
  const block = /^queues\s*\{$([\s\S]*?)^\}$/m.exec(contents);
  if (!block) throw new Error('elasticmq.conf has no `queues { ... }` block - did its format change?');
  return [...block[1].matchAll(/^\s*(\w+)\s*\{\s*\}\s*$/gm)].map(match => match[1]);
}

/** Queue names taken from the last path segment of each `*_QUEUE=` URL in the env template. */
function envTemplateQueueNames(): string[] {
  const contents = fs.readFileSync(path.join(REPO_ROOT, '.env.selfhost.example'), 'utf8');
  return [...contents.matchAll(/^[A-Z0-9_]+_QUEUE=\S*\/(\w+)$/gm)].map(match => match[1]);
}

const manifestQueueNames = Object.entries(DEFAULT_MANIFEST)
  .filter(([, entry]) => entry.kind === 'queue')
  .map(([name]) => name);

describe('self-host queue list parity', () => {
  it('reads a non-empty list from each source', () => {
    // Every assertion below compares two extracted lists, so a regex that silently stops
    // matching (a reformatted conf, a moved env block) would make them all pass on two empty
    // arrays. Pin the floors first so a broken reader fails as a broken reader.
    expect(elasticMqQueueNames().length).toBeGreaterThan(10);
    expect(envTemplateQueueNames().length).toBeGreaterThan(10);
    expect(manifestQueueNames.length).toBeGreaterThan(10);
  });

  it('declares the same queues in elasticmq.conf and .env.selfhost.example', () => {
    // Both directions matter: an env URL with no declared queue sends into the void, and a
    // declared queue with no env URL is a consumer nobody can address.
    expect([...elasticMqQueueNames()].sort()).toEqual([...envTemplateQueueNames()].sort());
  });

  it('predeclares every queue the manifest exposes to a self-host consumer', () => {
    // One-way on purpose: elasticmq.conf legitimately holds queues absent from the manifest
    // (selfHostEventQueue is read straight from env; overlay queues have no open-source entry).
    const declared = new Set(elasticMqQueueNames());
    expect(manifestQueueNames.filter(name => !declared.has(name))).toEqual([]);
  });

  it('registers a consumer-visible manifest entry for both image queues (#2174)', () => {
    // The regression this guard exists for: these two are what image generation and image edit
    // need, and the worker reads them off `Resource` rather than the sourceQueueUrls map.
    expect(manifestQueueNames).toContain('imageGenerationQueue');
    expect(manifestQueueNames).toContain('imageEditQueue');
  });
});
