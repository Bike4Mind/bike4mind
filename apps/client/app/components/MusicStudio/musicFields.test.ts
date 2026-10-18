import { describe, expect, it, vi } from 'vitest';
import type { PublicMusicModel } from '@bike4mind/common';
import type { CapabilityControl, CapabilityField } from '@client/app/components/Studio/capabilityFields';
import { formatRenderTime, musicCapabilityFields } from './musicFields';
import { initialFormFor, type MusicFormState } from './musicForm';

const model = (overrides: Partial<PublicMusicModel> = {}): PublicMusicModel => ({
  id: 'music_v2',
  object: 'music_model',
  display_name: 'Exact',
  provider: 'elevenlabs',
  vocals: 'optional',
  lyrics: { max_chars: 100, max_line_chars: null },
  duration: { control: 'exact', min: 3, max: 300, default: 60 },
  output_formats: ['mp3'],
  typical_render_seconds: 60,
  pricing: { unit: 'per_second', credits: 1 },
  preview: false,
  deprecation_date: null,
  ...overrides,
});

const controls = (fields: CapabilityField[]): CapabilityControl[] =>
  fields.flatMap(field => (field.kind === 'group' ? [...field.fields] : [field]));
const byId = (fields: CapabilityField[], id: string) => controls(fields).find(field => field.id === id);
const build = (m: PublicMusicModel, overrides: Partial<MusicFormState> = {}, update = vi.fn()) =>
  musicCapabilityFields(m, { ...initialFormFor(m), ...overrides }, update);

describe('musicCapabilityFields', () => {
  it('offers the lyric section tags and disables the lyrics while instrumental', () => {
    const lyrics = byId(build(model()), 'lyrics');
    expect(lyrics).toMatchObject({ kind: 'text', snippets: ['[Verse]', '[Chorus]', '[Bridge]'], disabled: false });
    expect(byId(build(model(), { instrumental: true }), 'lyrics')).toMatchObject({ disabled: true });
  });

  it('turns lyrics off through the instrumental switch', () => {
    const update = vi.fn();
    const toggle = byId(build(model(), {}, update), 'instrumental');
    if (toggle?.kind !== 'switch') throw new Error('expected a switch');
    toggle.onChange(true);
    expect(update).toHaveBeenCalledWith({ instrumental: true });
  });

  it('states an instrumental-only model rather than offering vocals or lyrics', () => {
    const fields = build(model({ vocals: 'never', lyrics: null }));
    expect(byId(fields, 'instrumental')).toMatchObject({ kind: 'note' });
    expect(byId(fields, 'lyrics')).toBeUndefined();
  });

  it('notes a model that writes its own lyrics', () => {
    expect(byId(build(model({ lyrics: null })), 'lyrics')).toMatchObject({
      kind: 'note',
      label: 'This model writes its own lyrics.',
    });
  });

  it('shows why the lyrics cannot be sent', () => {
    const fields = build(model({ lyrics: { max_chars: 100, max_line_chars: 3 } }), { lyrics: 'four' });
    expect(byId(fields, 'lyrics-problem')).toMatchObject({ kind: 'note' });
  });

  it.each([
    ['exact', 'Duration: 60s'],
    ['approximate', 'Duration: about 60s'],
  ] as const)('gives an %s model a duration slider', (control, label) => {
    const duration = byId(build(model({ duration: { control, min: 3, max: 300, default: 60 } })), 'duration');
    expect(duration).toMatchObject({ kind: 'range', label, min: 3, max: 300, step: 1, value: 60 });
  });

  it('states the length of a fixed model', () => {
    const duration = byId(build(model({ duration: { control: 'fixed', seconds: 30 } })), 'duration');
    expect(duration).toMatchObject({ kind: 'note', label: 'Songs are 30s long.' });
  });

  it('tells the user how long a song usually takes', () => {
    expect(byId(build(model()), 'render-time')).toMatchObject({ label: 'Usually ready in about 60 seconds.' });
    expect(formatRenderTime(150)).toBe('about 3 minutes');
  });
});
