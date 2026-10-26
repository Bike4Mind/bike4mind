import { Resource } from 'sst';
import type { DisposableListSource } from '@bike4mind/common';
import { connectDB } from '@bike4mind/db-core';
import {
  disposableDomainRepository,
  DisposableDomainModel,
  DisposableDomainSourceModel,
  DomainIntelligenceModel,
} from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { Config } from '@bike4mind/server-utils/utils/config';
import { emitMetrics } from '@bike4mind/server-utils/utils/cloudwatch';
import { registrableDomain } from '@bike4mind/utils/registrableDomain';

/**
 * Upstream lists, fetched at runtime into our DB; nothing is redistributed. The tier each source
 * gets is REJECT_TIER_SOURCES in b4m-core/services/src/userService/disposableEmail.ts.
 * Not ingested on purpose: the aggregate's domains_forwarding.txt (privacy relays real users rely on).
 */
export const DISPOSABLE_LIST_SOURCES: Record<DisposableListSource, string> = {
  // disposable/disposable-email-domains, MIT
  aggregate: 'https://raw.githubusercontent.com/disposable/disposable-email-domains/master/domains.txt',
  // disposable-email-domains/disposable-email-domains, CC0 1.0
  curated:
    'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf',
  // 7c/fakefilter, BSD-3-Clause
  fakefilter: 'https://raw.githubusercontent.com/7c/fakefilter/main/txt/data.txt',
};

const FETCH_TIMEOUT_MS = 30_000;
/** A snapshot smaller than this share of the last good count is treated as truncated. */
const MIN_SNAPSHOT_SHARE = 0.5;

/** Listed domains, lowercased as published. Drops comments, bare public suffixes and mailbox providers. */
export function parseDisposableList(text: string): Set<string> {
  const domains = new Set<string>();
  for (const line of text.split('\n')) {
    const domain = line.replace(/#.*/, '').trim().toLowerCase();
    if (!domain || userService.PUBLIC_MAILBOX_DOMAINS.has(domain)) continue;
    if (!registrableDomain(domain, { allowPrivateDomains: true })) continue;
    domains.add(domain);
  }
  return domains;
}

/** Why a snapshot must not replace the stored entries, or null when it is safe to apply. */
export function rejectSnapshot(size: number, previousCount: number | undefined): string | null {
  if (size === 0) return 'Empty snapshot';
  if (previousCount && size < previousCount * MIN_SNAPSHOT_SHARE)
    return `Snapshot of ${size} is under half the previous ${previousCount}`;
  return null;
}

async function refreshSource(source: DisposableListSource, previousCount: number | undefined, runAt: Date) {
  const response = await fetch(DISPOSABLE_LIST_SOURCES[source], { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const domains = parseDisposableList(await response.text());
  const rejected = rejectSnapshot(domains.size, previousCount);
  if (rejected) throw new Error(rejected);
  await disposableDomainRepository.replaceDisposableSource(source, domains, runAt);
  return domains.size;
}

/**
 * Daily refresh of the disposable-domain lists. A failing source keeps its previous entries; the
 * others still refresh. SourceFailures feeds the disposableDomainRefreshFailures alarm in
 * infra/alarms.ts - MUST STAY IN SYNC with its namespace, metric name and dimensions.
 */
export async function handler() {
  const dimensions = { Stage: Resource.App.stage };
  try {
    await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), undefined, { autoIndex: false });
    // The unique domain indexes must exist before the first concurrent upserts, so build them here.
    await Promise.all([
      DisposableDomainModel.createIndexes(),
      DisposableDomainSourceModel.createIndexes(),
      DomainIntelligenceModel.createIndexes(),
    ]);
    const previous = new Map(
      (await disposableDomainRepository.getDisposableSourceStatus()).map(status => [status.source, status.count])
    );
    const results: Record<string, number | string> = {};
    let failures = 0;
    for (const source of Object.keys(DISPOSABLE_LIST_SOURCES) as DisposableListSource[]) {
      const runAt = new Date();
      try {
        const count = await refreshSource(source, previous.get(source), runAt);
        await disposableDomainRepository.recordDisposableSource(source, { count, at: runAt });
        results[source] = count;
      } catch (error) {
        failures++;
        const message = error instanceof Error ? error.message : String(error);
        results[source] = message;
        try {
          await disposableDomainRepository.recordDisposableSource(source, { error: message, at: runAt });
        } catch (recordError) {
          console.warn('Could not record source failure', { source, error: String(recordError) });
        }
      }
    }
    console.log(JSON.stringify({ job: 'disposable-domain-refresh', failures, results }));
    await emitMetrics('Lumina5/DisposableDomains', [{ name: 'SourceFailures', value: failures, dimensions }]);
    return { status: failures ? 'partial' : 'success', results };
  } catch (error) {
    await emitMetrics('Lumina5/DisposableDomains', [{ name: 'SourceFailures', value: 1, dimensions }]);
    throw error;
  }
}
