import { describe, expect, it } from 'vitest';
import { resolveQuestModelType } from './questModelType';

describe('resolveQuestModelType', () => {
  it('reports the recorded model type', () => {
    expect(resolveQuestModelType({ promptMeta: { model: { type: 'text' } } })).toBe('text');
    expect(resolveQuestModelType({ promptMeta: { model: { type: 'image' } } })).toBe('image');
    expect(resolveQuestModelType({ promptMeta: { model: { type: 'video' } } })).toBe('video');
  });

  // The precedence bug this replaced classified every one of these as 'image'.
  it('keeps a text turn as text even when the quest carries images', () => {
    expect(resolveQuestModelType({ promptMeta: { model: { type: 'text' } }, images: ['s3://a.png'] })).toBe('text');
  });

  it('keeps a video turn as video even when the quest carries images', () => {
    expect(resolveQuestModelType({ promptMeta: { model: { type: 'video' } }, images: ['s3://a.png'] })).toBe('video');
  });

  it('falls back to attached images when no model type was recorded', () => {
    expect(resolveQuestModelType({ images: ['s3://a.png'] })).toBe('image');
    expect(resolveQuestModelType({ promptMeta: { model: {} }, images: ['s3://a.png'] })).toBe('image');
  });

  // Rows written before the completion path was constrained can hold a catalog type promptMeta
  // never declared. The declared return union would be a lie if such a value were passed through,
  // so it is treated as "no type recorded" and the images/text fallback decides.
  it('ignores a stored type outside the declared union', () => {
    expect(resolveQuestModelType({ promptMeta: { model: { type: 'speech-to-text' } } })).toBe('text');
    expect(resolveQuestModelType({ promptMeta: { model: { type: 'speech-to-text' } }, images: ['s3://a.png'] })).toBe(
      'image'
    );
    expect(resolveQuestModelType({ promptMeta: { model: { type: 'embedding' } } })).toBe('text');
  });

  it('defaults to text when neither a model type nor images are present', () => {
    expect(resolveQuestModelType({})).toBe('text');
    expect(resolveQuestModelType({ images: [] })).toBe('text');
    expect(resolveQuestModelType({ promptMeta: { model: { type: '' } } })).toBe('text');
    expect(resolveQuestModelType({ promptMeta: null, images: null })).toBe('text');
  });
});
