import { FORMAT_PROMPT_PRIORITY, IMAGE_PROMPT_PRIORITY } from '@bike4mind/utils';
import { describe, expect, it } from 'vitest';
import {
  buildTaggedContextMessages,
  filterByPromptMode,
  filterFeaturesByPromptMode,
  PROMPT_SOURCE_METADATA,
  PROMPT_SOURCE_ORDER,
  resolveForcedRetrieval,
  SYSTEM_PROMPT_PRIORITY,
  toPromptDetails,
  type PromptSourceId,
} from './systemPromptSources';

const sys = (content: string) => ({ role: 'system' as const, content });

describe('buildTaggedContextMessages', () => {
  it('emits sources in the declared assembly order, not the caller key order', () => {
    const tagged = buildTaggedContextMessages({
      mementos: [sys('memory')],
      dateContext: [sys('Current date: Monday')],
      helpCenter: [sys('help center')],
    });

    expect(tagged.map(t => t.source)).toEqual(['dateContext', 'helpCenter', 'mementos']);
  });

  it('tags every message with the source that contributed it', () => {
    const tagged = buildTaggedContextMessages({
      organizationPrompt: [sys('org rules')],
      knowledgeRetrieval: [sys('retrieved chunk A'), sys('retrieved chunk B')],
    });

    expect(tagged).toEqual([
      { source: 'organizationPrompt', message: sys('org rules') },
      { source: 'knowledgeRetrieval', message: sys('retrieved chunk A') },
      { source: 'knowledgeRetrieval', message: sys('retrieved chunk B') },
    ]);
  });

  it('omits a source that contributed nothing', () => {
    const tagged = buildTaggedContextMessages({ dateContext: [sys('Current date: Monday')], mementos: [] });

    expect(tagged.map(t => t.source)).toEqual(['dateContext']);
  });

  it('declares every source exactly once, so the order table cannot silently drop one', () => {
    expect(new Set(PROMPT_SOURCE_ORDER).size).toBe(PROMPT_SOURCE_ORDER.length);
  });

  it('describes every ordered source, so a new source cannot reach the prompt untagged', () => {
    expect(PROMPT_SOURCE_ORDER.filter(source => !PROMPT_SOURCE_METADATA[source])).toEqual([]);
  });

  // The compiler forces METADATA to cover the union but happily accepts a subset for ORDER, so a
  // new source declared everywhere except ORDER would silently vanish from every prompt.
  it('orders every described source, so a new source cannot silently drop out of assembly', () => {
    expect([...PROMPT_SOURCE_ORDER].sort()).toEqual(Object.keys(PROMPT_SOURCE_METADATA).sort());
  });
});

describe('SYSTEM_PROMPT_PRIORITY', () => {
  // Same hazard as the ORDER/METADATA pair above: the compiler forces the record to cover the union
  // but not the reverse, so a stale key would sit here unnoticed after a source was renamed.
  it('prioritizes exactly the ordered sources, no more and no less', () => {
    expect(Object.keys(SYSTEM_PROMPT_PRIORITY).sort()).toEqual([...PROMPT_SOURCE_ORDER].sort());
  });

  // The defect this table exists to fix. Retention used to follow assembly position, and these two sit
  // at the tail of PROMPT_SOURCE_ORDER, so they were the first things dropped.
  it('keeps tenant and session prompts ahead of the guidance we author ourselves', () => {
    const authored = ['toolPrompt', 'viewRegistry', 'abstention', 'artifactEmission', 'helpCenter', 'dateContext'];
    const mostImportantAuthored = Math.min(...authored.map(source => SYSTEM_PROMPT_PRIORITY[source as PromptSourceId]));

    expect(SYSTEM_PROMPT_PRIORITY.organizationPrompt).toBeLessThan(mostImportantAuthored);
    expect(SYSTEM_PROMPT_PRIORITY.sessionPrompt).toBeLessThan(mostImportantAuthored);
  });

  it('keeps grounding data ahead of authored guidance, since the model cannot infer it', () => {
    expect(SYSTEM_PROMPT_PRIORITY.knowledgeRetrieval).toBeLessThan(SYSTEM_PROMPT_PRIORITY.artifactEmission);
    expect(SYSTEM_PROMPT_PRIORITY.contextSummary).toBeLessThan(SYSTEM_PROMPT_PRIORITY.helpCenter);
  });

  // The builder assigns these two itself because @bike4mind/utils cannot import this package. Nothing
  // holds the two tables in the same order except this assertion, and the whole point of the change is
  // that the builder's own prepended blocks stop outranking a tenant's prompt.
  it('ranks every caller source ahead of the blocks buildAndSortMessages injects', () => {
    const lowestBuilderInjected = Math.min(IMAGE_PROMPT_PRIORITY, FORMAT_PROMPT_PRIORITY);

    expect(Math.max(...Object.values(SYSTEM_PROMPT_PRIORITY))).toBeLessThan(lowestBuilderInjected);
  });
});

describe('filterByPromptMode', () => {
  // Every source the assembly can produce, so a mode that forgets to exclude one is caught here
  // rather than in an eval run.
  const everything = buildTaggedContextMessages(
    Object.fromEntries(PROMPT_SOURCE_ORDER.map(source => [source, [sys(source)]]))
  );

  it('leaves the stack untouched when no mode is set, so existing callers are unaffected', () => {
    expect(filterByPromptMode(everything, undefined)).toEqual(everything);
  });

  it('drops every prompt we inject under raw', () => {
    const kept = filterByPromptMode(everything, 'raw').map(t => t.source);

    expect(kept).not.toContain('dateContext');
    expect(kept).not.toContain('artifactEmission');
    expect(kept).not.toContain('helpCenter');
    expect(kept).not.toContain('abstention');
    expect(kept).not.toContain('toolPrompt');
    expect(kept).not.toContain('mementos');
    expect(kept).not.toContain('knowledgeRetrieval');
  });

  it('keeps what the caller themselves supplied under raw', () => {
    expect(filterByPromptMode(everything, 'raw').map(t => t.source)).toEqual(['extraContext', 'urls', 'attachedFiles']);
  });

  it('adds retrieval and nothing else under grounded', () => {
    expect(filterByPromptMode(everything, 'grounded').map(t => t.source)).toEqual([
      'extraContext',
      'knowledgeRetrieval',
      'lakeMemory',
      'urls',
      'attachedFiles',
    ]);
  });

  it('adds the surface-authored prompts on top of grounded under surface', () => {
    expect(filterByPromptMode(everything, 'surface').map(t => t.source)).toEqual([
      'extraContext',
      'organizationPrompt',
      'sessionPrompt',
      'knowledgeRetrieval',
      'lakeMemory',
      'urls',
      'attachedFiles',
    ]);
  });

  it('preserves assembly order rather than the order the mode lists sources in', () => {
    const filtered = filterByPromptMode(everything, 'surface').map(t => t.source);
    const assemblyOrder = PROMPT_SOURCE_ORDER.filter(source => filtered.includes(source));

    expect(filtered).toEqual(assemblyOrder);
  });
});

describe('filterFeaturesByPromptMode', () => {
  it('builds every feature when no mode is set', () => {
    expect(filterFeaturesByPromptMode(['mementos', 'questMaster', 'skills'], undefined)).toEqual([
      'mementos',
      'questMaster',
      'skills',
    ]);
  });

  // Filtering the assembled messages is not enough on its own: MementoFeature distils the turn into
  // durable user memory as a side effect, so a mode that only suppressed the injected text would
  // still poison later completions. The feature has to not be built at all.
  it.each(['raw', 'grounded', 'surface'] as const)('never builds memory under %s', mode => {
    expect(filterFeaturesByPromptMode(['mementos', 'skills'], mode)).not.toContain('mementos');
  });

  it('drops the features that author their own prompt content when a mode is set', () => {
    expect(filterFeaturesByPromptMode(['questMaster', 'agentDetection', 'skills'], 'raw')).toEqual(['skills']);
  });

  // contextSummarization writes session.contextSummary as a side effect, and that field is an
  // admitted source in every non-raw mode - so a mode turn that ran it would quietly shape what
  // future in-app completions on the same session see.
  it.each(['raw', 'grounded', 'surface'] as const)('never summarizes context under %s', mode => {
    expect(filterFeaturesByPromptMode(['contextSummarization', 'skills'], mode)).toEqual(['skills']);
  });
});

describe('resolveForcedRetrieval', () => {
  it('follows the session flag when no mode is set', () => {
    expect(resolveForcedRetrieval(undefined, true)).toBe(true);
    expect(resolveForcedRetrieval(undefined, false)).toBe(false);
    expect(resolveForcedRetrieval(undefined, undefined)).toBe(false);
  });

  // raw promises "nothing but the caller's message", so a session left on forced retrieval must
  // not quietly ground it anyway.
  it('never retrieves under raw, whatever the session says', () => {
    expect(resolveForcedRetrieval('raw', true)).toBe(false);
  });

  // grounded/surface promise grounding by name; depending on a session field the caller may not
  // know about would make the mode silently degrade to raw.
  it.each(['grounded', 'surface'] as const)('always retrieves under %s, whatever the session says', mode => {
    expect(resolveForcedRetrieval(mode, false)).toBe(true);
    expect(resolveForcedRetrieval(mode, undefined)).toBe(true);
  });
});

describe('toPromptDetails', () => {
  // One char per token keeps the arithmetic legible; the real caller passes the tokenizer.
  const countChars = async (messages: { content: unknown }[]) =>
    messages.reduce((sum, m) => sum + String(m.content).length, 0);

  it('reports one row per contributing source, with that source telemetry name and origin', async () => {
    const tagged = buildTaggedContextMessages({ dateContext: [sys('abc')], mementos: [sys('de')] });

    await expect(toPromptDetails(tagged, countChars)).resolves.toEqual([
      { source: 'hardcoded', name: 'date_time_context', tokenCount: 3, wasIncluded: true },
      { source: 'user', name: 'mementos', tokenCount: 2, wasIncluded: true },
    ]);
  });

  it('sums the tokens of every message a single source contributed', async () => {
    const tagged = buildTaggedContextMessages({ knowledgeRetrieval: [sys('abc'), sys('de')] });

    const details = await toPromptDetails(tagged, countChars);

    expect(details).toHaveLength(1);
    expect(details[0].tokenCount).toBe(5);
  });

  // The hand-written telemetry this replaces reported a `session_summary` row sourced from
  // `session.summary`, a field the assembled prompt never carried.
  it('reports nothing for a source that contributed no messages', async () => {
    await expect(toPromptDetails(buildTaggedContextMessages({}), countChars)).resolves.toEqual([]);
  });

  it('reports a source the budget dropped as excluded, billing it nothing', async () => {
    const kept = sys('abc');
    const dropped = sys('de');
    const tagged = buildTaggedContextMessages({ dateContext: [kept], mementos: [dropped] });

    const details = await toPromptDetails(tagged, countChars, new Set([kept]));

    expect(details).toEqual([
      { source: 'hardcoded', name: 'date_time_context', tokenCount: 3, wasIncluded: true },
      // Zero rather than 2: the model never saw it, so billing its tokens would overstate the prompt.
      { source: 'user', name: 'mementos', tokenCount: 0, wasIncluded: false },
    ]);
  });

  it('still counts a source as included when only some of its messages survived', async () => {
    const kept = sys('abc');
    const dropped = sys('de');
    const tagged = buildTaggedContextMessages({ knowledgeRetrieval: [kept, dropped] });

    const details = await toPromptDetails(tagged, countChars, new Set([kept]));

    expect(details[0].wasIncluded).toBe(true);
    expect(details[0].tokenCount).toBe(3);
  });

  // A caller that has not built the payload cannot say what was delivered, and must not be forced to
  // claim everything was dropped.
  it('treats every contributing source as included when no payload is supplied', async () => {
    const tagged = buildTaggedContextMessages({ dateContext: [sys('abc')] });

    await expect(toPromptDetails(tagged, countChars)).resolves.toEqual([
      { source: 'hardcoded', name: 'date_time_context', tokenCount: 3, wasIncluded: true },
    ]);
  });
});
