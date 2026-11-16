/**
 * Evidence-line templates for the reason a lifecycle suggestion is accepted with.
 *
 * The reason is the audit trail for a lifecycle row, so the route still requires
 * one and the admin still reviews it. What this saves is the typing: each
 * suggestion already knows its source, its dates and (usually) its provider,
 * and the vendor page that confirms it is the same page for every model that
 * provider serves.
 */

export type LifecycleProvider = 'openai' | 'anthropic' | 'gemini' | 'bedrock';

/** What the builder reads off a queue item; a structural subset of LifecycleQueueItem. */
export type NoteSubject = {
  modelId: string;
  /** The serving backend when the server could resolve it; otherwise inferred from the id. */
  backend?: string;
  /** Consecutive misses, carried only for absence-raised suggestions. */
  missCount?: number;
  suggestion?: {
    status?: string;
    deprecationDate?: string;
    retirementDate?: string;
    replacedBy?: string;
    source: string;
  };
};

type ProviderPage = {
  label: string;
  url: string;
  /** The words the vendor's own page uses for the two dates. */
  deprecationWord: string;
  retirementWord: string;
};

/** Each provider's official deprecation page. Keep these on the vendor's own domain. */
export const PROVIDER_DEPRECATION_PAGES: Record<LifecycleProvider, ProviderPage> = {
  openai: {
    label: 'OpenAI deprecations page',
    url: 'https://developers.openai.com/api/docs/deprecations',
    deprecationWord: 'Deprecated',
    retirementWord: 'shutdown',
  },
  anthropic: {
    label: 'Anthropic model deprecations page',
    url: 'https://platform.claude.com/docs/en/about-claude/model-deprecations',
    deprecationWord: 'Deprecated',
    retirementWord: 'retired',
  },
  gemini: {
    label: 'Google AI Studio deprecations page',
    url: 'https://aistudio.google.com/docs/deprecations',
    deprecationWord: 'Deprecated',
    retirementWord: 'shutdown',
  },
  bedrock: {
    label: 'AWS Bedrock legacy page',
    url: 'https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle-legacy.html',
    deprecationWord: 'Legacy',
    retirementWord: 'EOL',
  },
};

const KNOWN_BACKENDS = new Set<string>(Object.keys(PROVIDER_DEPRECATION_PAGES));

/**
 * Bedrock ids are `<vendor>.<model>`, optionally behind a cross-region inference
 * prefix (`us.anthropic.claude-...`). The vendor segment is letters and dashes
 * only, which keeps `gpt-4.1` and `gemini-2.5-pro` out.
 */
const BEDROCK_ID = /^(?:(?:us|eu|apac|global|jp|au|ca)\.)?[a-z][a-z-]*\.[a-z0-9]/;
const OPENAI_ID = /^(?:gpt-|chatgpt-|o\d|text-embedding-|dall-e|whisper|tts-|davinci|babbage|codex-|computer-use)/;
const ANTHROPIC_ID = /^claude-/;
const GEMINI_ID = /^(?:gemini-|imagen-|veo-|gemma-)/;

/**
 * The provider whose deprecation page confirms this model. The server's backend
 * wins; the id patterns are the fallback for a model the merged list no longer
 * carries, which is most of what this queue holds.
 */
export function inferLifecycleProvider(subject: Pick<NoteSubject, 'modelId' | 'backend'>): LifecycleProvider | null {
  if (subject.backend && KNOWN_BACKENDS.has(subject.backend)) return subject.backend as LifecycleProvider;
  // A backend we hold no page for (xai, kimi, ...) must not fall through to an id guess.
  if (subject.backend) return null;
  const id = subject.modelId.toLowerCase();
  if (BEDROCK_ID.test(id)) return 'bedrock';
  if (OPENAI_ID.test(id)) return 'openai';
  if (ANTHROPIC_ID.test(id)) return 'anthropic';
  if (GEMINI_ID.test(id)) return 'gemini';
  return null;
}

function datePhrase(subject: NoteSubject, page: ProviderPage | null): string | null {
  const suggestion = subject.suggestion;
  const parts: string[] = [];
  if (suggestion?.deprecationDate) parts.push(`${page?.deprecationWord ?? 'Deprecated'} ${suggestion.deprecationDate}`);
  if (suggestion?.retirementDate) parts.push(`${page?.retirementWord ?? 'retired'} ${suggestion.retirementDate}`);
  return parts.length > 0 ? parts.join(', ') : null;
}

/** The discovery signal that raised the suggestion, in the words an auditor needs. */
export function sourcePhrase(subject: Pick<NoteSubject, 'suggestion' | 'missCount'>): string {
  const source = subject.suggestion?.source;
  switch (source) {
    case 'litellm':
      return 'LiteLLM model map carries the deprecation';
    case 'models.dev':
      return 'models.dev carries the deprecation';
    case 'heuristic':
      return 'successor chosen by the family heuristic';
    case 'absence':
      return subject.missCount
        ? `absent from the provider model list for ${subject.missCount} runs`
        : 'absent from the provider model list';
    case undefined:
      return 'unknown signal';
    default:
      return `${source} signal`;
  }
}

/**
 * One evidence line for one suggestion, e.g.
 * `AWS Bedrock legacy page (https://...): Legacy 2026-09-30, EOL 2027-03-30. Signal: LiteLLM model map carries the deprecation.`
 */
export function buildLifecycleNote(subject: NoteSubject): string {
  const provider = inferLifecycleProvider(subject);
  const page = provider ? PROVIDER_DEPRECATION_PAGES[provider] : null;
  const dates = datePhrase(subject, page);
  const status = subject.suggestion?.status;
  const finding = dates ?? (status ? `status ${status}` : 'no dates given');
  const evidence = page ? `${page.label} (${page.url}): ${finding}.` : `${finding}.`;
  return `${evidence} Signal: ${sourcePhrase(subject)}.`;
}

/**
 * The shared note for a bulk settle. When every selected row would get the same
 * line (the usual case: one provider's batch with one set of dates) that line is
 * the note. Otherwise it names each distinct vendor page and the distinct
 * signals, and leaves the per-row dates to the rows themselves - each row's
 * catalog patch already records its own dates.
 *
 * Past `maxLength` (the reason field's limit) it drops the page URLs, then the
 * page and signal lists, which each row's suggestion still records.
 */
export function buildBulkLifecycleNote(subjects: readonly NoteSubject[], maxLength = Infinity): string {
  if (subjects.length === 0) return '';
  const lines = new Set(subjects.map(buildLifecycleNote));
  if (lines.size === 1) return [...lines][0];

  const providers = new Set<LifecycleProvider>();
  for (const subject of subjects) {
    const provider = inferLifecycleProvider(subject);
    if (provider) providers.add(provider);
  }
  const signals = new Set(subjects.map(subject => sourcePhrase(subject)));
  const compose = (withUrls: boolean) => {
    const pages = [...providers].map(provider => {
      const page = PROVIDER_DEPRECATION_PAGES[provider];
      return withUrls ? `${page.label} (${page.url})` : page.label;
    });
    const pageText = pages.length > 0 ? `Confirmed on ${pages.join('; ')}` : 'Confirmed on the vendor pages';
    return `${pageText}: dates as suggested per row. Signals: ${[...signals].join('; ')}.`;
  };

  for (const note of [compose(true), compose(false)]) {
    if (note.length <= maxLength) return note;
  }
  return 'Confirmed on the vendor pages: dates and signals as suggested per row.';
}
