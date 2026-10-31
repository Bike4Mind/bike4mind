import { readFileSync } from 'fs';
import { join } from 'path';
import type { IMessage } from '@bike4mind/common';
import { FORMAT_PROMPT_PRIORITY, IMAGE_PROMPT_PRIORITY } from '@bike4mind/utils';
import { describe, expect, it } from 'vitest';
import { ALL_FEATURE_NAMES } from './ChatCompletionFeatures';
import {
  buildTaggedContextMessages,
  filterByPromptMode,
  filterFeaturesByPromptMode,
  isPerTurnContext,
  LAKE_CONTENT_LAYER_NAMES,
  LAKE_CONTENT_SOURCES,
  lakeContentTokens,
  markHistoryCacheAnchor,
  PER_TURN_CONTEXT_SOURCES,
  PROMPT_SOURCE_METADATA,
  PROMPT_SOURCE_ORDER,
  relocatePerTurnContext,
  resolveForcedRetrieval,
  resolveIdentityReminder,
  markShareablePrefixBoundary,
  SHAREABLE_PREFIX_SOURCES,
  PER_CALLER_AUTHORED_SOURCES,
  SIDE_EFFECT_ONLY_FEATURES,
  SYSTEM_PROMPT_PRIORITY,
  TURN_CONTEXT_END,
  TURN_CONTEXT_HEADER,
  toPromptDetails,
  type PromptSourceId,
  type SystemPromptDetail,
} from './systemPromptSources';

const sys = (content: string) => ({ role: 'system' as const, content });

describe('buildTaggedContextMessages', () => {
  it('emits sources in the declared assembly order, not the caller key order', () => {
    const tagged = buildTaggedContextMessages({
      mementos: [sys('memory')],
      dateContext: [sys('Current date: Monday')],
      helpCenter: [sys('help center')],
    });

    expect(tagged.map(t => t.source)).toEqual(['helpCenter', 'dateContext', 'mementos']);
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

  // The quote carries up to MAX_QUOTED_ANSWER_CHARS + MAX_QUOTED_PROMPT_CHARS of text the model
  // usually still has in history. Ranked with the framing it would evict the two prompts below it.
  it('ranks the correction framing ahead of the tenant prompts but its quote behind them', () => {
    expect(SYSTEM_PROMPT_PRIORITY.correction).toBeLessThan(SYSTEM_PROMPT_PRIORITY.organizationPrompt);
    expect(SYSTEM_PROMPT_PRIORITY.correction).toBeLessThan(SYSTEM_PROMPT_PRIORITY.sessionPrompt);
    expect(SYSTEM_PROMPT_PRIORITY.correctionQuote).toBeGreaterThan(SYSTEM_PROMPT_PRIORITY.organizationPrompt);
    expect(SYSTEM_PROMPT_PRIORITY.correctionQuote).toBeGreaterThan(SYSTEM_PROMPT_PRIORITY.sessionPrompt);
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

describe('SHAREABLE_PREFIX_SOURCES', () => {
  it('is the contiguous leading run of deployment-wide sources', () => {
    const firstPerCaller = PROMPT_SOURCE_ORDER.findIndex(
      source =>
        !['hardcoded', 'admin'].includes(PROMPT_SOURCE_METADATA[source].origin) ||
        PER_CALLER_AUTHORED_SOURCES.includes(source)
    );

    expect(SHAREABLE_PREFIX_SOURCES).toEqual(PROMPT_SOURCE_ORDER.slice(0, firstPerCaller));
  });

  it('carries no per-caller source, which would make the region unshareable', () => {
    const perCaller = SHAREABLE_PREFIX_SOURCES.filter(
      source =>
        !['hardcoded', 'admin'].includes(PROMPT_SOURCE_METADATA[source].origin) ||
        PER_CALLER_AUTHORED_SOURCES.includes(source)
    );

    expect(perCaller).toEqual([]);
  });

  it('excludes recentImages, which is hardcoded but sits behind per-caller content', () => {
    // The reason the run has to be contiguous rather than an origin filter over the whole table:
    // a prompt cache matches on a prefix, so a shared block behind a per-caller one is not shared.
    expect(SHAREABLE_PREFIX_SOURCES).not.toContain('recentImages');
  });

  // Each of these is text we author, so `origin` alone would admit it, but each varies by caller:
  // the date per timezone-day, the admin view appendix per role, the tool context per user and
  // session, agent prompts per mention. dateContext used to LEAD the run, which made the whole
  // "shared" head a per-timezone-day cache write.
  it.each(['dateContext', 'viewRegistryAdmin', 'toolContext', 'agentDetection'] as const)(
    'keeps the per-caller %s out of the shared run',
    source => {
      expect(SHAREABLE_PREFIX_SOURCES).not.toContain(source);
    }
  );

  it('is wide enough to be worth a breakpoint at all', () => {
    // A one-source prefix is the failure this table exists to prevent: extraContext once sat at
    // position 2 and cut the run down to the date line alone, and a ~13-token head can never clear
    // Anthropic's 1024-token minimum cacheable block, so the breakpoint would never materialise.
    expect(SHAREABLE_PREFIX_SOURCES.length).toBeGreaterThan(1);
  });
});

describe('markShareablePrefixBoundary', () => {
  it('marks the last shareable message and nothing else', () => {
    const tagged = buildTaggedContextMessages({
      dateContext: [sys('date')],
      artifactEmission: [sys('artifacts')],
      abstention: [sys('abstain')],
      sessionPrompt: [sys('per session')],
      mementos: [sys('per user')],
    });

    markShareablePrefixBoundary(tagged);

    expect(tagged.map(t => [t.source, t.message.cache === true])).toEqual([
      ['artifactEmission', false],
      ['abstention', true],
      ['dateContext', false],
      ['sessionPrompt', false],
      ['mementos', false],
    ]);
  });

  it('mutates in place, because callers key priorities and delivery off the message reference', () => {
    const message = sys('abstain');
    const tagged = buildTaggedContextMessages({ abstention: [message] });

    markShareablePrefixBoundary(tagged);

    expect(message.cache).toBe(true);
    expect(tagged[0].message).toBe(message);
  });

  it('is a no-op when nothing shareable survived the gates, rather than marking an arbitrary block', () => {
    const tagged = buildTaggedContextMessages({ sessionPrompt: [sys('per session')], mementos: [sys('per user')] });

    markShareablePrefixBoundary(tagged);

    expect(tagged.some(t => t.message.cache === true)).toBe(false);
  });

  it('lands on the last SURVIVING shareable block when a gate dropped the one behind it', () => {
    // The boundary is applied after the promptMode filter for this reason: marking a block that
    // does not ship declares a breakpoint the request never carries.
    const tagged = buildTaggedContextMessages({ artifactEmission: [sys('artifacts')], mementos: [sys('per user')] });

    markShareablePrefixBoundary(tagged);

    expect(tagged[0].message.cache).toBe(true);
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

  // Correct-and-retry is reachable from any surface that can send a turn, and the framing is the
  // only thing separating "re-answer this correctly" from "answer this critique as a question".
  it('keeps the correction framing and its quote under every mode', () => {
    for (const mode of ['raw', 'grounded', 'surface'] as const) {
      const kept = filterByPromptMode(everything, mode).map(t => t.source);
      expect(kept).toContain('correction');
      expect(kept).toContain('correctionQuote');
    }
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
    expect(filterByPromptMode(everything, 'raw').map(t => t.source)).toEqual([
      'extraContext',
      'urls',
      'attachedFiles',
      'correction',
      'correctionQuote',
      'callerPrompt',
    ]);
  });

  it('adds retrieval and nothing else under grounded', () => {
    expect(filterByPromptMode(everything, 'grounded').map(t => t.source)).toEqual([
      'extraContext',
      'knowledgeRetrieval',
      'lakeMemory',
      'urls',
      'attachedFiles',
      'correction',
      'correctionQuote',
      'callerPrompt',
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
      'correction',
      'correctionQuote',
      'callerPrompt',
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

describe('lakeContentTokens', () => {
  const row = (name: string, tokenCount: number, wasIncluded = true): SystemPromptDetail => ({
    source: 'session',
    name,
    tokenCount,
    wasIncluded,
  });

  it('sums only the delivered lake rows, leaving every other layer out', () => {
    const details = [
      row('knowledge_retrieval', 30),
      row('lake_memory', 40),
      row('session_prompt', 100),
      // Dropped by the budget: billing it would overstate the prompt.
      row('knowledge_retrieval', 999, false),
    ];

    expect(lakeContentTokens(details)).toBe(70);
  });

  // The names come from PROMPT_SOURCE_METADATA rather than a second hand-written list, so a
  // source rename cannot leave this bucket summing a name no row reports as.
  it('derives the layer names from the source metadata', () => {
    expect(LAKE_CONTENT_SOURCES).toEqual(['knowledgeRetrieval', 'lakeMemory']);
    expect(LAKE_CONTENT_LAYER_NAMES).toEqual(LAKE_CONTENT_SOURCES.map(source => PROMPT_SOURCE_METADATA[source].name));
  });

  // Load-bearing distinction: a real zero must not be reachable from "the derivation failed".
  it('returns 0 for details with no lake rows but undefined for missing details', () => {
    expect(lakeContentTokens([row('session_prompt', 5)])).toBe(0);
    expect(lakeContentTokens(undefined)).toBeUndefined();
  });
});

// A ChatCompletionFeature that registers into this.features, runs getContextMessages, and returns
// non-empty content is otherwise silently discarded if its key never reaches the assembly - the
// SkillsFeature and lakeMemory drops were both this shape. Guards against a THIRD occurrence.
describe('feature-to-source reconciliation', () => {
  const contentProducingFeatures = ALL_FEATURE_NAMES.filter(name => !SIDE_EFFECT_ONLY_FEATURES.includes(name));

  // Table-membership guard: catches a feature never given a PromptSourceId at all.
  it('gives every content-producing feature a PromptSourceId consumed by the assembly', () => {
    const missing = contentProducingFeatures.filter(name => !PROMPT_SOURCE_ORDER.includes(name as PromptSourceId));

    expect(missing).toEqual([]);
  });

  // CRITICAL: a table-membership check alone is a proxy, not the invariant. #1344 was fixed by
  // adding 'skills' to PROMPT_SOURCE_ORDER AND the assembly literal in the same commit, so a future
  // feature that is dutifully added to every table but never spread into the literal would pass the
  // check above while reproducing #1344/#1404 exactly. This reads the real assembly source instead
  // of trusting the tables as a stand-in for it.
  //
  // Trade-off: this matches a literal substring, so it is brittle to a purely cosmetic reformat of
  // the spread line (quote style, wrapping) that does not change the actual wiring. A failure here
  // is worth a quick look at the diff before assuming a real drop.
  it('actually spreads every content-producing feature key into the ChatCompletionProcess assembly', () => {
    const assemblySource = readFileSync(join(__dirname, 'ChatCompletionProcess.ts'), 'utf-8');
    const notWired = contentProducingFeatures.filter(
      name => !assemblySource.includes(`${name}: featureContextMessages['${name}']`)
    );

    expect(notWired).toEqual([]);
  });

  // Correct-and-retry is not a ChatCompletionFeature, so the two checks above never see it, and
  // nothing else does either: deleting the spread leaves the suite green while the feature becomes a
  // no-op that still writes the link and still renders the "Correction" chip. Same literal-substring
  // trade-off as above - a cosmetic reformat of the spread trips this, so read the diff first.
  it('spreads the correction sources into the ChatCompletionProcess assembly', () => {
    const assemblySource = readFileSync(join(__dirname, 'ChatCompletionProcess.ts'), 'utf-8');

    // Anchored to a whole line rather than a bare substring, so commenting the wiring out fails
    // too - `// ...correctionContextMessages,` satisfies `includes` just as happily as the live line.
    expect(/^\s*\.\.\.correctionContextMessages,\s*$/m.test(assemblySource)).toBe(true);
    expect(
      /^\s*const correctionContextMessages = await resolveCorrectionContext\(quest, this\.db\.quests, logger\);\s*$/m.test(
        assemblySource
      )
    ).toBe(true);
  });
});

describe('per-turn context placement', () => {
  const user = (content: string) => ({ role: 'user' as const, content });
  const tag = (source: PromptSourceId, message: IMessage) => ({ source, message });

  describe('PER_TURN_CONTEXT_SOURCES', () => {
    it('never overlaps the shareable head, which has to be identical for every caller', () => {
      for (const source of PER_TURN_CONTEXT_SOURCES) {
        expect(SHAREABLE_PREFIX_SOURCES).not.toContain(source);
      }
    });

    it('keeps the session-stable sources out', () => {
      for (const stable of ['contextSummary', 'project', 'organizationPrompt', 'sessionPrompt', 'callerPrompt']) {
        expect(PER_TURN_CONTEXT_SOURCES).not.toContain(stable);
      }
    });
  });

  describe('isPerTurnContext', () => {
    it.each(['mementos', 'knowledgeRetrieval', 'lakeMemory'] as PromptSourceId[])('moves a %s message', source => {
      expect(isPerTurnContext(tag(source, sys('text')))).toBe(true);
    });

    it('keeps the stable sources in system', () => {
      for (const source of ['contextSummary', 'project', 'callerPrompt', 'dateContext'] as PromptSourceId[]) {
        expect(isPerTurnContext(tag(source, sys('text')))).toBe(false);
      }
    });

    it('moves caller extra context only where the producer flagged it per turn', () => {
      const view = sys('[Current View Context] User is on the Admin page.');
      const perSend = sys('Refine the open brief.');
      const flagged = new Set<IMessage>([view]);

      expect(isPerTurnContext(tag('extraContext', view), flagged)).toBe(true);
      // Voice, Slack and programmatic launches put a real system prompt through this same channel.
      expect(isPerTurnContext(tag('extraContext', perSend), flagged)).toBe(false);
      expect(isPerTurnContext(tag('extraContext', sys('[ADMIN_PROMPT:bike4mind_identity]\nIdentity')), flagged)).toBe(
        false
      );
    });

    it('leaves attachments in system, whose notice is an instruction, and moves only the URL notice', () => {
      expect(isPerTurnContext(tag('attachedFiles', sys('# Available Files')))).toBe(false);
      expect(isPerTurnContext(tag('attachedFiles', user('file body')))).toBe(false);
      expect(isPerTurnContext(tag('urls', sys('# URL content')))).toBe(true);
      expect(isPerTurnContext(tag('urls', user('page body')))).toBe(false);
    });

    it('leaves block-array content where it is, since only text can be inlined', () => {
      const blocks = { role: 'system' as const, content: [{ type: 'text', text: 'x' }] } as unknown as IMessage;

      expect(isPerTurnContext(tag('mementos', blocks))).toBe(false);
    });
  });

  describe('relocatePerTurnContext', () => {
    const head = sys('stable head');
    const summary = sys('stable summary');
    const memento = sys('[Memento] likes tea');
    const passage = sys('[Passages] chunk');
    const prompt = user('what should I drink?');

    const relocate = (messages: IMessage[], moved: IMessage[], current: IMessage = prompt) =>
      relocatePerTurnContext(messages, new Set(moved), current);

    it('lifts the per-turn messages out of system into the front of the current user message', () => {
      const { messages, relocatedCount } = relocate([head, memento, summary, passage, prompt], [memento, passage]);

      expect(relocatedCount).toBe(2);
      expect(messages.slice(0, 2)).toEqual([head, summary]);
      expect(messages).toHaveLength(3);
      expect(messages[2]).toEqual({
        role: 'user',
        content: `${TURN_CONTEXT_HEADER}[Memento] likes tea\n\n[Passages] chunk${TURN_CONTEXT_END}what should I drink?`,
      });
    });

    it('does not mutate its inputs', () => {
      const input = [head, memento, prompt];

      relocate(input, [memento]);

      expect(input).toEqual([head, memento, prompt]);
      expect(prompt.content).toBe('what should I drink?');
    });

    it('returns the same array when there is nothing to move', () => {
      const input = [head, prompt];

      expect(relocate(input, [])).toEqual({ messages: input, relocatedCount: 0 });
      expect(relocate(input, [])).toHaveProperty('messages', input);
    });

    it('finds the prompt by identity when it is not the last message', () => {
      const attachment = user('attached file');

      const { messages } = relocate([head, memento, prompt, attachment], [memento]);

      expect(messages.map(m => m.content)).toEqual([
        'stable head',
        `${TURN_CONTEXT_HEADER}[Memento] likes tea${TURN_CONTEXT_END}what should I drink?`,
        'attached file',
      ]);
    });

    it('prepends a text block to a prompt that already carries content blocks', () => {
      const blocks = { role: 'user' as const, content: [{ type: 'text', text: 'hi' }] } as unknown as IMessage;

      const { messages } = relocate([memento, blocks], [memento], blocks);

      expect((messages[0].content as Array<{ text: string }>).map(b => b.text)).toEqual([
        `${TURN_CONTEXT_HEADER}[Memento] likes tea${TURN_CONTEXT_END}`,
        'hi',
      ]);
    });

    it('leaves the messages where they were when no user turn can receive them', () => {
      const input = [head, memento, sys('trailing system')];

      expect(relocate(input, [memento])).toEqual({ messages: input, relocatedCount: 0 });
    });

    it('gives the same system prefix whatever the per-turn context was', () => {
      const turn = (mementoText: string) => {
        const m = sys(mementoText);
        return relocate([head, m, summary, prompt], [m]).messages.filter(x => x.role === 'system');
      };

      expect(JSON.stringify(turn('[Memento] likes tea'))).toBe(JSON.stringify(turn('[Memento] likes coffee')));
    });
  });

  describe('markHistoryCacheAnchor', () => {
    const head = sys('stable head');
    const answer = { role: 'assistant' as const, content: 'earlier answer' };
    const attachment = user('attached file');
    const prompt = user('this turn');

    it('flags the last history message, not the volatile current turn', () => {
      const marked = markHistoryCacheAnchor([head, answer, attachment, prompt], answer);

      expect(marked.map(m => m.cache)).toEqual([undefined, true, undefined, undefined]);
      // A copy, so the caller's array and the persisted message stay unmarked.
      expect(marked[1]).not.toBe(answer);
      expect(answer.cache).toBeUndefined();
    });

    it('anchors on the last message of history when the turn is a bare prompt', () => {
      expect(markHistoryCacheAnchor([head, answer, prompt], answer).map(m => m.cache)).toEqual([
        undefined,
        true,
        undefined,
      ]);
    });

    it('returns the input unchanged when there is no history to anchor', () => {
      const messages = [head, prompt];

      expect(markHistoryCacheAnchor(messages, undefined)).toBe(messages);
    });

    // Identity, not position: a history message the build truncated or dropped is not in the payload,
    // and flagging whatever now sits at its index would cache a message the next turn never repeats.
    it('returns the input unchanged when the history message did not survive the build', () => {
      const messages = [head, prompt];

      expect(markHistoryCacheAnchor(messages, answer)).toBe(messages);
    });

    it('returns the input unchanged rather than flag a system message', () => {
      const messages = [head, sys('more context'), prompt];

      expect(markHistoryCacheAnchor(messages, messages[1])).toBe(messages);
    });

    it('returns the input unchanged when the next message shares the anchor role', () => {
      // Flagging turns the content into a block array, which the adapter then refuses to merge with
      // the same-role message after it - that message would be dropped instead of joined.
      const messages = [head, user('no answer yet'), prompt];

      expect(markHistoryCacheAnchor(messages, messages[1])).toBe(messages);
    });

    it('flags a tool_result that ends history even though the current prompt is a user turn too', () => {
      const toolResult: IMessage = {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] as IMessage['content'],
      };

      expect(markHistoryCacheAnchor([head, toolResult, prompt], toolResult).map(m => m.cache)).toEqual([
        undefined,
        true,
        undefined,
      ]);
    });
  });
});

describe('resolveIdentityReminder', () => {
  it.each([
    ['the tool is offered', undefined, ['web_search', 'current_model_details'], false, true],
    ['raw, tool-less', 'raw', [], true, false],
    ['raw, tool offered', 'raw', ['current_model_details'], true, true],
    ['tool-less default turn', undefined, [], false, false],
    ['tool stripped (Ollama trim, deny-list, non-tool model)', undefined, ['web_search'], false, false],
    ['grounded without the tool', 'grounded', [], false, false],
  ] as const)('%s', (_label, promptMode, offeredToolNames, omit, viaTool) => {
    expect(resolveIdentityReminder({ promptMode, offeredToolNames })).toEqual({
      omitIdentityReminder: omit,
      identityViaTool: viaTool,
    });
  });
});
