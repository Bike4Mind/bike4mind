/**
 * @vitest-environment node
 *
 * An org alert raised in a Lambda without eventBus in its link loses its email.send publish silently
 * (notifyOrgEvent swallows the error). Text-matched: infra/ is an SST program and does not load outside `sst`.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { balanced, soleMatch, stripComments } from './helpers/infraSource';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => readFileSync(path.join(REPO_ROOT, file), 'utf8');

// Importing any of these runs registerOrgAlertObserver at module load.
const REGISTERING_MODULES = [
  'packages/server-utils/src/queueHandlers/utils.ts',
  'packages/server-utils/src/s3/utils.ts',
  'packages/server-utils/src/websocket/utils.ts',
  'apps/workers/src/utils/eventContext.ts',
];

// Built from parts so the infra handler scan in packages/scripts does not read these as handler paths.
const WORKERS = ['apps', 'workers', 'src'].join('/');
const CLIENT_SERVER = ['apps', 'client', 'server'].join('/');

/**
 * Observer-registering handlers left without the bus because no path from them to an org debit or
 * org event was found. Trace a handler before adding it here; once it can raise one, link eventBus.
 */
const NOT_TRACED_TO_AN_ORG_EVENT = new Set([
  // Socket handlers; $default only routes to the keep command handlers. Voice settlement only refunds
  // the unused hold.
  ...[
    'agentExecute',
    'ccAgentDisconnect',
    'ccAgentEvent',
    'ccAgentRegister',
    'connect',
    'dataSubscribeRequest',
    'dataUnsubscribeRequest',
    'disconnect',
    'heartbeat',
    'jupyterNotebookProgress',
    'keepCommandRequest',
    'keepCommandResponse',
    'default',
    'reauthConnection',
    'voiceSessionEnded',
    'voiceSessionSendTranscript',
  ].map(name => `${CLIENT_SERVER}/websocket/${name}`),
  // Hold sweeps refund; grant releases pay users from platform pools; the risk sweep only queues refreshes.
  ...[
    'creditHoldSweep',
    'voiceHoldSweep',
    'signupGrantHeldRelease',
    'signupDomainHoldTriage',
    'signupRiskSweep',
    'secopsTriageWorker',
  ].map(name => `${WORKERS}/cron/${name}`),
  // Runs on the lake owner's own provider keys, unmetered.
  `${WORKERS}/emailIngestion/emailAnalyzer`,
  `${WORKERS}/queueHandlers/lakeInconsistencyModelDetection`,
  // Containment debits a User holder, never an org.
  `${WORKERS}/queueHandlers/riskEvidence`,
  // Ingest, purge, export, delivery and notification work; no metered completion found.
  `${WORKERS}/events/moderationEscalationAlert`,
  `${WORKERS}/events/sendPush`,
  `${WORKERS}/events/studioJobCompleted`,
  `${WORKERS}/s3/appFileUploadComplete`,
  `${WORKERS}/s3/historyUploadComplete`,
  ...[
    'callableFunctionCall',
    'dataLakeCleanup',
    'driveDisconnectPurge',
    'driveLakeIngest',
    'fabFileChunk',
    'generatedMediaPurge',
    'generationCallback',
    'githubLakeIngest',
    'githubLakeRevoke',
    'githubWebhook',
    'publishThumbnail',
    'questExport',
    'slackExport',
    'sreFix',
    'webhookDelivery',
    'whatsNewJob',
  ].map(name => `${WORKERS}/queueHandlers/${name}`),
]);

// Import specifiers resolved to repo files; anything else (b4m-core packages, npm) never registers.
const IMPORT_ALIASES: [string, string][] = [
  ['@bike4mind/server-utils/', 'packages/server-utils/src/'],
  ['@workers/', `${WORKERS}/`],
  ['@server/', `${CLIENT_SERVER}/`],
  ['@client/', 'apps/client/'],
  ['@/', 'apps/client/'],
];
const IMPORT =
  /(?:^|[\s;])(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm;

function resolveImport(fromFile: string, specifier: string): string | undefined {
  let target: string | undefined;
  if (specifier.startsWith('.')) target = path.posix.join(path.posix.dirname(fromFile), specifier);
  else {
    const alias = IMPORT_ALIASES.find(([prefix]) => specifier.startsWith(prefix));
    if (alias) target = alias[1] + specifier.slice(alias[0].length);
  }
  if (target === undefined) return undefined;
  return [`${target}.ts`, `${target}.tsx`, `${target}/index.ts`, target].find(
    candidate => /\.tsx?$/.test(candidate) && existsSync(path.join(REPO_ROOT, candidate))
  );
}

const registersCache = new Map<string, boolean>();
/** Whether loading `entry` runs registerOrgAlertObserver(), directly or through any local import. */
function reachesObserver(entry: string): boolean {
  const cached = registersCache.get(entry);
  if (cached !== undefined) return cached;
  const seen = new Set([entry]);
  const queue = [entry];
  let found = false;
  while (queue.length && !found) {
    const file = queue.shift() as string;
    const source = stripComments(read(file));
    if (/\bregisterOrgAlertObserver\(\)/.test(source)) found = true;
    for (const match of source.matchAll(IMPORT)) {
      const next = resolveImport(file, match[1] ?? match[2] ?? match[3]);
      if (next && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  registersCache.set(entry, found);
  return found;
}

/** The `link` array of the props object itself, not one nested in `transform` or similar; '' when absent. */
function topLevelLink(props: string): string {
  const key = /\blink:\s*\[/y;
  let depth = 0;
  for (let i = 0; i < props.length; i++) {
    if ('{[('.includes(props[i])) depth++;
    else if ('}])'.includes(props[i])) depth--;
    else if (depth === 1) {
      key.lastIndex = i;
      if (key.test(props)) return balanced(props, i, '[', ']');
    }
  }
  return '';
}

type Site = { file: string; module: string; registers: boolean; link: string };

const HANDLER = new RegExp(`handler:\\s*['"\`]((?:${WORKERS}|${CLIENT_SERVER})/[^'"\`]+)\\.\\w+['"\`]`, 'g');

/** Every handler declared in infra/*.ts, with whether it reaches the observer and the link of its props object. */
function scanSites(): Site[] {
  const sites: Site[] = [];
  const infraFiles = readdirSync(path.join(REPO_ROOT, 'infra')).filter(name => name.endsWith('.ts'));
  for (const name of infraFiles) {
    const file = `infra/${name}`;
    const source = stripComments(read(file));
    for (const match of source.matchAll(HANDLER)) {
      const module = match[1];
      const sourceFile = [`${module}.ts`, `${module}.tsx`, `${module}/index.ts`].find(candidate =>
        existsSync(path.join(REPO_ROOT, candidate))
      );
      // Premium handlers are generated at deploy time and absent from this tree; they are pinned below.
      if (!sourceFile) continue;
      let depth = 0;
      let open = match.index;
      for (; open >= 0; open--) {
        if (source[open] === '}') depth++;
        else if (source[open] === '{' && depth-- === 0) break;
      }
      let close = match.index;
      for (depth = 0; close < source.length; close++) {
        if (source[close] === '{') depth++;
        else if (source[close] === '}' && depth-- === 0) break;
      }
      const props = source.slice(open, close);
      sites.push({
        file,
        module,
        registers: reachesObserver(sourceFile),
        link: topLevelLink(props),
      });
    }
  }
  return sites;
}

const linksBus = (link: string) => /\beventBus\b/.test(link);
const SITES = scanSites();

describe('handlers that raise org alerts link the event bus', () => {
  it('finds the observer-registering handlers', () => {
    expect(SITES.filter(site => site.registers).length).toBeGreaterThan(NOT_TRACED_TO_AN_ORG_EVENT.size);
  });

  it('every observer-registering handler links eventBus unless listed as not traced to an org event', () => {
    const missing = SITES.filter(
      site => site.registers && !linksBus(site.link) && !NOT_TRACED_TO_AN_ORG_EVENT.has(site.module)
    ).map(site => `${site.module} in ${site.file}: link ${site.link || '(none)'} lacks eventBus`);
    expect(missing, 'link eventBus, or trace the handler and list it in NOT_TRACED_TO_AN_ORG_EVENT').toEqual([]);
  });

  it('lists only handlers that still register the observer without the bus', () => {
    const stale = [...NOT_TRACED_TO_AN_ORG_EVENT].filter(
      module => !SITES.some(site => site.module === module && site.registers && !linksBus(site.link))
    );
    expect(stale, 'drop these from NOT_TRACED_TO_AN_ORG_EVENT').toEqual([]);
  });

  it.each(REGISTERING_MODULES)('%s registers the observer', file => {
    expect(stripComments(read(file))).toMatch(/\bregisterOrgAlertObserver\(\)/);
  });

  // Debiting a run can raise an org alert; the handler source is generated, so it is matched by name.
  // The other generated queue handlers were traced and debit no org holder.
  it('links the event bus on the Bob run worker', () => {
    const queues = stripComments(read('infra/queues.ts'));
    const subscribe = soleMatch(
      queues,
      /const bobRunQueueSubscription = bobRunQueue\.subscribe\(/g,
      'bob run queue subscription'
    );
    const subscription = balanced(queues, subscribe.index, '(', ')');
    const [, link] = soleMatch(subscription, /\blink:\s*\[([^\]]*)\]/g, 'bob run worker link');
    expect(link.split(',').map(entry => entry.trim())).toContain('eventBus');
  });
});
