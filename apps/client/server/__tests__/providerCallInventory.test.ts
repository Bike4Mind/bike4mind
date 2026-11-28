import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  parseProviderCatalog,
  scanProviderSources,
  validateProviderCatalog,
  type ProviderEntry,
} from './providerCallInventory';

const file = 'apps/workers/src/task.ts';
const raw = `import { getLlmByModel as build } from '@bike4mind/llm-adapters';
export async function task() { const llm = build(keys, options); await llm.complete(model, messages); }`;
const scan = (source = raw) => scanProviderSources({ [file]: source });
const debt = (source = raw): ProviderEntry[] =>
  scan(source).sites.map(site => ({
    id: site.id,
    classification: 'debt',
    reason: 'No usage observer at this boundary.',
  }));

const SRE_INDEX = 'b4m-core/services/src/sreAgentService/index.ts';
const PLATFORM_METER = 'b4m-core/services/src/billing/platformCompletionMeter.ts';
const SECOPS_SERVICE = 'apps/workers/src/services/secopsTriageService.ts';
const repositoryRoot = new URL('../../../../', import.meta.url);
const platformFiles = [SRE_INDEX, PLATFORM_METER, SECOPS_SERVICE];
const platformSources = () =>
  Object.fromEntries(platformFiles.map(file => [file, readFileSync(new URL(file, repositoryRoot), 'utf8')]));
const platformEntries = () =>
  parseProviderCatalog(
    readFileSync(new URL('scripts/unmetered-provider-call-allowlist.txt', repositoryRoot), 'utf8')
  ).filter(entry => platformFiles.some(file => entry.id.startsWith(`${file}#`)));

describe('reviewed platform provider boundaries', () => {
  it('recognizes the shared settlement and owned SRE and SecOps wrappers without retaining their debt', () => {
    const entries = platformEntries();
    const scan = scanProviderSources(platformSources());
    expect(scan.sites.map(site => site.kind).sort()).toEqual(['completion', 'factory', 'factory']);
    expect(entries).toHaveLength(3);
    expect(entries.filter(entry => entry.classification === 'metered')).toHaveLength(2);
    expect(entries.filter(entry => entry.classification === 'forwarded')).toHaveLength(1);
    expect(entries.some(entry => entry.classification === 'debt')).toBe(false);
    expect(validateProviderCatalog(scan, entries, [])).toEqual([]);
  });

  it.each([
    {
      name: 'removing the SRE constructor',
      file: SRE_INDEX,
      before: 'new SreCompletionMeter(this.accounting)',
      after: 'undefined',
      error: 'Missing boundary call',
    },
    {
      name: 'calling the SRE constructor as an ordinary function',
      file: SRE_INDEX,
      before: 'new SreCompletionMeter',
      after: 'SreCompletionMeter',
      error: 'Missing boundary call',
    },
    {
      name: 'bypassing the SRE wrapper',
      file: SRE_INDEX,
      before: 'await meter.complete(',
      after: 'await llm.complete(',
      error: 'Unclassified provider site',
    },
    {
      name: 'disconnecting settlement',
      file: PLATFORM_METER,
      before: 'context.accounting.settle',
      after: 'context.other.settle',
      error: 'Missing boundary call',
    },
    {
      name: 'removing the SecOps constructor',
      file: SECOPS_SERVICE,
      before: 'new PlatformCompletionMeter',
      after: 'undefined',
      error: 'Missing boundary call',
    },
    {
      name: 'calling the SecOps constructor as an ordinary function',
      file: SECOPS_SERVICE,
      before: 'new PlatformCompletionMeter',
      after: 'PlatformCompletionMeter',
      error: 'Missing boundary call',
    },
    {
      name: 'bypassing the SecOps wrapper',
      file: SECOPS_SERVICE,
      before: 'await meter.complete(',
      after: 'await llmInit.llm.complete(',
      error: 'Unclassified provider site',
    },
  ])('rejects $name', ({ file, before, after, error }) => {
    const sources = platformSources();
    expect(sources[file]).toContain(before);
    sources[file] = sources[file].replaceAll(before, after);
    expect(validateProviderCatalog(scanProviderSources(sources), platformEntries(), [])).toEqual(
      expect.arrayContaining([expect.stringContaining(error)])
    );
  });

  it.each([
    { file: SRE_INDEX, before: 'SreAgentService', after: 'OtherService' },
    { file: PLATFORM_METER, before: 'PlatformCompletionMeter', after: 'OtherMeter' },
  ])('does not authorize another owner through the $before witness', ({ file, before, after }) => {
    const sources = platformSources();
    sources[file] = sources[file].replaceAll(before, after);
    const entries = platformEntries().map(entry => ({
      ...entry,
      id: entry.id.replaceAll(`${before}/`, `${after}/`),
      witness: entry.witness?.replaceAll(`${before}/`, `${after}/`),
    }));
    expect(validateProviderCatalog(scanProviderSources(sources), entries, [])).toEqual(
      expect.arrayContaining([expect.stringContaining('Unknown metering boundary')])
    );
  });

  it('does not treat another context settlement method as the platform accounting boundary', () => {
    const sources = platformSources();
    sources[PLATFORM_METER] = sources[PLATFORM_METER].replaceAll('context.accounting.settle', 'context.other.settle');
    const entries = platformEntries().map(entry => ({
      ...entry,
      witness: entry.witness?.replace('this.context.accounting.settle', 'this.context.other.settle'),
    }));
    expect(validateProviderCatalog(scanProviderSources(sources), entries, [])).toEqual(
      expect.arrayContaining([expect.stringContaining('Unknown metering boundary')])
    );
  });
});

describe('provider inventory backstop', () => {
  it.each([
    'apps/client/pages/api/new-provider.ts',
    'apps/workers/src/task.ts',
    'b4m-core/services/src/task.ts',
    'apps/client/server/utils/task.ts',
    'packages/server-utils/src/task.ts',
  ])('rejects new factory and completion sites in %s', path => {
    const result = scanProviderSources({ [path]: raw });
    expect(result.sites.map(site => site.kind)).toEqual(['factory', 'completion']);
    expect(validateProviderCatalog(result, [], [])).toHaveLength(2);
  });

  it('rejects a new raw SDK route even when it never uses a completion factory', () => {
    const result = scanProviderSources({
      'apps/client/pages/api/new-provider.ts':
        "import OpenAI from 'openai'; export async function handler() { const client = new OpenAI({}); await client.responses.create({}); }",
    });
    expect(result.sites.map(site => site.kind)).toEqual(['sdk-constructor', 'sdk-send']);
    expect(validateProviderCatalog(result, [], [])).toHaveLength(2);
  });

  it('tracks paid sends through arbitrarily named factory results and their aliases', () => {
    const result = scan(`import { getLlmByModel as build } from '@bike4mind/llm-adapters';
function task() { const client = build(keys, options); const alias = client; client.complete(model, messages); alias.complete(model, messages); }`);
    expect(result.sites.map(site => site.kind)).toEqual(['factory', 'completion', 'completion']);
  });

  it('tracks provider constructor aliases and paid sends for four SDK families', () => {
    const result = scan(`import { Anthropic as A } from '@anthropic-ai/sdk';
import O from 'openai'; import { BedrockRuntimeClient as B } from '@aws-sdk/client-bedrock-runtime';
import { GoogleGenAI as G } from '@google/genai';
function run() { const Constructor = A; const client = new Constructor({}); const alias = client;
const messages = alias.messages; messages.create({}); const open = new O({}); open.responses.create({});
const bedrock = new B({}); bedrock.send(command); const google = new G({}); google.models.generateContent({}); }`);
    expect(result.sites.filter(site => site.kind === 'sdk-constructor')).toHaveLength(4);
    expect(result.sites.filter(site => site.kind === 'sdk-send')).toHaveLength(4);
    expect(validateProviderCatalog(result, [], [])).toHaveLength(8);
  });

  it('keeps a forwarded multi-file boundary explicit and rejects an unrelated local metering claim', () => {
    const caller = 'apps/client/server/owner.ts';
    const result = scanProviderSources({
      [file]: raw,
      [caller]: 'export function own() { const llm = meterCompletionBackend(raw, meter); return llm; }',
    });
    const entries: ProviderEntry[] = result.sites.map(site => ({
      id: site.id,
      classification: 'forwarded',
      reason: 'Helper receives the backend returned by own; the caller supplies metering.',
      witness: `${caller}#own::meterCompletionBackend`,
    }));
    expect(validateProviderCatalog(result, entries, entries)).toEqual([]);
    expect(
      validateProviderCatalog(
        result,
        entries.map(entry => ({ ...entry, classification: 'metered' })),
        []
      )
    ).toEqual(expect.arrayContaining([expect.stringContaining('Meter is outside call owner')]));
    const removed = scanProviderSources({
      [file]: raw,
      [caller]: "import { meterCompletionBackend } from 'billing'; export function own() { return raw; }",
    });
    expect(validateProviderCatalog(removed, entries, [])).toEqual(
      expect.arrayContaining([expect.stringContaining('Missing boundary call')])
    );
  });

  it('ignores imports, strings and comments as provider or meter calls', () => {
    expect(
      scan(`import { getLlmByModel } from '@bike4mind/llm-adapters';
// getLlmByModel(); meterCompletionBackend();
const text = 'new OpenAI({}); llm.complete();';`).sites
    ).toEqual([]);
    const entries = debt();
    const source = `${raw}\n// meterCompletionBackend(llm, meter);`;
    expect(validateProviderCatalog(scan(source), entries, entries)).toEqual([]);
  });

  it('accepts explicit metered and forwarded boundaries without certifying unrelated functions', () => {
    const source = raw
      .replace('const llm =', 'let llm =')
      .replace('await llm.complete', 'llm = meterCompletionBackend(llm, meter); await llm.complete');
    const result = scan(source);
    const entries: ProviderEntry[] = result.sites.map(site => ({
      id: site.id,
      classification: 'metered',
      reason: 'Backend wrapped in the owning function.',
      witness: `${file}#task::meterCompletionBackend`,
    }));
    expect(validateProviderCatalog(result, entries, [])).toEqual([]);
    const unrelated = scan(`${raw}\nfunction unrelated() { meterCompletionBackend(other, meter); }`);
    expect(validateProviderCatalog(unrelated, entries, [])).toEqual(
      expect.arrayContaining([expect.stringContaining('Missing boundary call')])
    );
    const forwarded: ProviderEntry[] = unrelated.sites.map(site => ({
      id: site.id,
      classification: 'forwarded',
      reason: 'Caller supplies the usage boundary; conditional, not an unconditional metering claim.',
      witness: `${file}#unrelated::meterCompletionBackend`,
    }));
    expect(validateProviderCatalog(unrelated, forwarded, forwarded)).toEqual([]);
  });

  it('rejects a second call in an existing debt function and stale entries after removal', () => {
    const entries = debt();
    const added = scan(
      raw.replace(
        'await llm.complete(model, messages);',
        'await llm.complete(model, messages); await llm.complete(model, messages);'
      )
    );
    expect(validateProviderCatalog(added, entries, entries)).toEqual([
      expect.stringContaining('Unclassified provider site'),
    ]);
    expect(validateProviderCatalog(scan(''), entries, entries)).toHaveLength(2);
    expect(validateProviderCatalog(scan(), [...entries, entries[0]], entries)).toEqual([
      expect.stringContaining('Duplicate inventory entry'),
    ]);
  });

  it('does not certify a paid call from a reservation or an unused meter factory', () => {
    for (const marker of ['reserveCompletionCredits', 'reserveRequestCredits', 'createRequestCompletionMeter']) {
      const result = scan(`${raw.replace('await llm.complete', `${marker}(request, budget); await llm.complete`)}`);
      const entries: ProviderEntry[] = result.sites.map(site => ({
        id: site.id,
        classification: 'metered',
        reason: 'Reservation alone is not a usage write.',
        witness: `${file}#task::${marker}`,
      }));
      expect(validateProviderCatalog(result, entries, [])).toEqual([
        expect.stringContaining('Unknown metering boundary'),
        expect.stringContaining('Unknown metering boundary'),
      ]);
    }
  });

  it('requires debt cleanup when a real wrapper is added and forbids growing the baseline', () => {
    const entries = debt();
    expect(validateProviderCatalog(scan(), entries, [])).toHaveLength(2);
    const metered = raw
      .replace('const llm =', 'let llm =')
      .replace('await llm.complete', 'llm = meterCompletionBackend(llm, meter); await llm.complete');
    expect(validateProviderCatalog(scan(metered), entries, entries)).toHaveLength(2);
    expect(validateProviderCatalog(scan(), entries.slice(0, 1), entries)).toEqual([
      expect.stringContaining('Unclassified provider site'),
    ]);
  });
});

describe('static SDK receiver regressions', () => {
  const cases = [
    {
      name: 'bound local method',
      source: `async function task() { const client = new A({}); BODY }`,
      send: 'const send = client.messages.create.bind(client.messages); await send({});',
      second: 'await send({});',
    },
    {
      name: 'class field',
      source: `class Task { private sdk = new A({}); async run() { BODY } }`,
      send: 'await this.sdk.messages.create({});',
      second: 'await this.sdk.messages.create({});',
    },
    {
      name: 'private SDK field',
      source: `class Task { #sdk = new A({}); async run() { BODY } }`,
      send: 'await this.#sdk.messages.create({});',
      second: 'await this.#sdk.messages.create({});',
    },
    {
      name: 'static SDK field',
      source: `class Task { static sdk = new A({}); } async function task() { BODY }`,
      send: 'await Task.sdk.messages.create({});',
      second: 'await Task.sdk.messages.create({});',
    },
    {
      name: 'constructor member assignment',
      source: `class Task { private sdk: A; constructor() { this.sdk = new A({}); } async run() { BODY } }`,
      send: 'await this.sdk.messages.create({});',
      second: 'await this.sdk.messages.create({});',
    },
    {
      name: 'bound class member',
      source: `class Task { private sdk = new A({}); private send = this.sdk.messages.create.bind(this.sdk.messages); async run() { BODY } }`,
      send: 'await this.send({});',
      second: 'await this.send({});',
    },
  ];
  it.each(cases)('requires inventory for first and additional paid sends through $name', ({ source, send, second }) => {
    const make = (body: string) =>
      `import { Anthropic as A } from '@anthropic-ai/sdk'; ${source.replace('BODY', body)}`;
    const constructors = scan(make(''));
    expect(constructors.sites.map(site => site.kind)).toEqual(['sdk-constructor']);
    const entries: ProviderEntry[] = constructors.sites.map(site => ({
      id: site.id,
      classification: 'forwarded',
      reason: 'Construction only; paid sends must be inventoried separately.',
      witness: `${file}#${site.owner}::Anthropic`,
    }));
    const first = scan(make(send));
    expect(first.sites.filter(site => site.kind === 'sdk-send')).toHaveLength(1);
    expect(validateProviderCatalog(first, entries, entries)).toEqual([
      expect.stringContaining('Unclassified provider site'),
    ]);
    const firstEntry: ProviderEntry = {
      id: first.sites.find(site => site.kind === 'sdk-send')!.id,
      classification: 'debt',
      reason: 'Existing paid send has no observer.',
    };
    const baseline = [...entries, firstEntry];
    expect(validateProviderCatalog(scan(make(`${send} ${second}`)), baseline, baseline)).toEqual([
      expect.stringContaining('Unclassified provider site'),
    ]);
  });

  it('recognizes paid sends on inline SDK construction', () => {
    const result = scan(
      `import A from '@anthropic-ai/sdk'; async function task() { await new A({}).messages.create({}); }`
    );
    expect(result.sites.map(site => site.kind).sort()).toEqual(['sdk-constructor', 'sdk-send']);
  });

  it('rejects a new forwarded paid send even when an unrelated witness exists', () => {
    const result = scan(`${raw}\nfunction unrelated() { meterCompletionBackend(other, meter); }`);
    const entries: ProviderEntry[] = result.sites.map(site => ({
      id: site.id,
      classification: 'forwarded',
      reason: 'A named function exists but does not prove a usage boundary.',
      witness: `${file}#unrelated::meterCompletionBackend`,
    }));
    expect(validateProviderCatalog(result, entries, [])).toEqual([
      expect.stringContaining('Forwarded paid-site inventory grew'),
    ]);
    expect(validateProviderCatalog(result, entries, entries)).toEqual([]);
  });
});
