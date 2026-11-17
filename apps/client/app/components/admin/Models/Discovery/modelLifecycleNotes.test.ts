import { describe, expect, it } from 'vitest';
import {
  PROVIDER_DEPRECATION_PAGES,
  buildBulkLifecycleNote,
  buildLifecycleNote,
  inferLifecycleProvider,
  type NoteSubject,
} from './modelLifecycleNotes';

const subject = (modelId: string, suggestion: Partial<NonNullable<NoteSubject['suggestion']>>, extra = {}) => ({
  modelId,
  suggestion: { source: 'litellm', ...suggestion },
  ...extra,
});

describe('inferLifecycleProvider', () => {
  it('prefers the backend the server resolved', () => {
    expect(inferLifecycleProvider({ modelId: 'claude-sonnet-4', backend: 'bedrock' })).toBe('bedrock');
  });

  it('does not guess from the id when the backend is one with no page', () => {
    expect(inferLifecycleProvider({ modelId: 'gpt-oss-120b', backend: 'xai' })).toBeNull();
  });

  it.each([
    ['anthropic.claude-3-haiku-20240307-v1:0', 'bedrock'],
    ['us.anthropic.claude-3-5-sonnet-20241022-v2:0', 'bedrock'],
    ['meta.llama3-70b-instruct-v1:0', 'bedrock'],
    ['gpt-4.1-mini', 'openai'],
    ['o3-mini', 'openai'],
    ['text-embedding-3-small', 'openai'],
    ['claude-3-opus-20240229', 'anthropic'],
    ['gemini-2.5-pro', 'gemini'],
    ['some-unknown-model', null],
  ])('infers %s as %s', (modelId, expected) => {
    expect(inferLifecycleProvider({ modelId })).toBe(expected);
  });
});

describe('buildLifecycleNote', () => {
  it('writes the Bedrock evidence line in the legacy page vocabulary', () => {
    const note = buildLifecycleNote(
      subject('anthropic.claude-v2', { deprecationDate: '2026-09-30', retirementDate: '2027-03-30' })
    );
    expect(note).toBe(
      `AWS Bedrock legacy page (${PROVIDER_DEPRECATION_PAGES.bedrock.url}): Legacy 2026-09-30, EOL 2027-03-30. ` +
        'Signal: LiteLLM model map carries the deprecation.'
    );
  });

  it('names the OpenAI page and the models.dev signal', () => {
    const note = buildLifecycleNote({
      modelId: 'gpt-4o-2024-05-13',
      suggestion: { source: 'models.dev', deprecationDate: '2026-12-01' },
    });
    expect(note).toContain('developers.openai.com/api/docs/deprecations');
    expect(note).toContain('Deprecated 2026-12-01');
    expect(note).toContain('Signal: models.dev carries the deprecation.');
  });

  it('omits the run count when the model was seen again or the count is unknown', () => {
    for (const extra of [{ missCount: 0 }, {}]) {
      const note = buildLifecycleNote(
        subject('claude-experimental', { source: 'absence', status: 'deprecated' }, extra)
      );
      expect(note).toContain('Signal: absent from the provider model list.');
    }
  });

  it('carries the miss count for an absence-raised suggestion', () => {
    const note = buildLifecycleNote(
      subject('claude-experimental', { source: 'absence', status: 'deprecated' }, { missCount: 4 })
    );
    expect(note).toBe(
      `Anthropic model deprecations page (${PROVIDER_DEPRECATION_PAGES.anthropic.url}): status deprecated. ` +
        'Signal: absent from the provider model list for 4 runs.'
    );
  });

  it('still produces a non-empty line for an unknown provider and source', () => {
    const note = buildLifecycleNote({ modelId: 'mystery', suggestion: { source: 'anthropic-docs' } });
    expect(note).toBe('no dates given. Signal: anthropic-docs signal.');
  });

  it('flags a heuristic successor for checking', () => {
    expect(buildLifecycleNote(subject('gemini-1.5-pro', { source: 'heuristic' }))).toContain(
      'successor chosen by the family heuristic'
    );
  });
});

describe('buildBulkLifecycleNote', () => {
  it('uses the shared line when every row would get the same one', () => {
    const rows = ['anthropic.claude-v2', 'anthropic.claude-instant-v1'].map(id =>
      subject(id, { deprecationDate: '2026-09-30', retirementDate: '2027-03-30' })
    );
    expect(buildBulkLifecycleNote(rows)).toBe(buildLifecycleNote(rows[0]));
  });

  it('lists each distinct vendor page and signal when the rows differ', () => {
    const note = buildBulkLifecycleNote([
      subject('anthropic.claude-v2', { deprecationDate: '2026-09-30' }),
      subject('gpt-4-0613', { deprecationDate: '2026-10-01', source: 'models.dev' }),
      subject('gpt-4-0314', { deprecationDate: '2026-10-02' }),
    ]);
    expect(note).toContain(PROVIDER_DEPRECATION_PAGES.bedrock.url);
    expect(note).toContain(PROVIDER_DEPRECATION_PAGES.openai.url);
    expect(note).toContain('dates as suggested per row');
    expect(note).toContain('LiteLLM model map carries the deprecation; models.dev carries the deprecation');
  });

  it('is empty for an empty selection', () => {
    expect(buildBulkLifecycleNote([])).toBe('');
  });

  it('drops the page URLs, then the lists, to fit the reason field', () => {
    const rows = [
      subject('anthropic.claude-v2', { deprecationDate: '2026-09-30' }),
      subject('gpt-4-0613', { deprecationDate: '2026-10-01', source: 'models.dev' }),
      subject('claude-2.1', { source: 'absence', status: 'retired' }, { missCount: 6 }),
      subject('gemini-1.0-pro', { source: 'heuristic', status: 'deprecated' }),
    ];
    const full = buildBulkLifecycleNote(rows);
    const labels = buildBulkLifecycleNote(rows, full.length - 1);

    expect(labels.length).toBeLessThan(full.length);
    expect(labels).toContain('AWS Bedrock legacy page; OpenAI deprecations page');
    expect(labels).not.toContain('https://');
    expect(labels).toContain('absent from the provider model list for 6 runs');
    expect(buildBulkLifecycleNote(rows, labels.length - 1)).toBe(
      'Confirmed on the vendor pages: dates and signals as suggested per row.'
    );
  });
});
