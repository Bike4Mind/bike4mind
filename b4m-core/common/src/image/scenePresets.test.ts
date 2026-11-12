import { describe, expect, it } from 'vitest';
import { IMAGE_JOB_PROMPT_MAX_CHARS } from './jobRequest';
import {
  SCENE_PRESETS,
  SCENE_PROMPT_FRAGMENT_MAX_CHARS,
  SCENE_SWATCHES,
  SCENE_SWATCH_TOKENS,
  ScenePresetListSchema,
  ScenePresetSchema,
  SceneSwatchSchema,
  appliedScenePreset,
  applyScenePreset,
} from './scenePresets';

const preset = (id: string) => {
  const found = SCENE_PRESETS.find(candidate => candidate.id === id);
  if (!found) throw new Error(`no preset ${id}`);
  return found;
};

describe('scene preset schema', () => {
  const valid = { id: 'wet-slate', name: 'Wet slate', swatch: 'slate', promptFragment: 'on wet slate' };

  it('ships the curated list in order', () => {
    expect(SCENE_PRESETS.map(scene => scene.name)).toEqual(['Wet slate', 'Kitchen counter', 'Studio white', 'Picnic']);
  });

  it('accepts a well-formed preset', () => {
    expect(ScenePresetSchema.parse(valid)).toEqual(valid);
  });

  it.each([
    ['a non-slug id', { id: 'Wet Slate' }],
    ['an empty name', { name: '' }],
    ['an unknown swatch token', { swatch: 'neon' }],
    ['an empty fragment', { promptFragment: '' }],
    ['an untrimmed fragment', { promptFragment: ' on wet slate ' }],
    ['an overlong fragment', { promptFragment: 'x'.repeat(SCENE_PROMPT_FRAGMENT_MAX_CHARS + 1) }],
  ])('rejects %s', (_label, patch) => {
    expect(ScenePresetSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });

  it('rejects an empty list and duplicate ids', () => {
    expect(ScenePresetListSchema.safeParse([]).success).toBe(false);
    expect(ScenePresetListSchema.safeParse([valid, valid]).success).toBe(false);
  });

  it('gives every swatch token valid gradient stops', () => {
    for (const token of SCENE_SWATCH_TOKENS)
      expect(SceneSwatchSchema.safeParse(SCENE_SWATCHES[token]).success).toBe(true);
  });

  it('keeps a fragment well inside the image prompt limit', () => {
    expect(SCENE_PROMPT_FRAGMENT_MAX_CHARS).toBeLessThan(IMAGE_JOB_PROMPT_MAX_CHARS);
  });
});

describe('applyScenePreset', () => {
  const slate = preset('wet-slate');
  const picnic = preset('picnic');

  it('fills an empty prompt with the fragment', () => {
    expect(applyScenePreset('  ', slate)).toBe(slate.promptFragment);
  });

  it("appends the fragment after the user's own words", () => {
    expect(applyScenePreset('A lemon tart ', slate)).toBe(`A lemon tart, ${slate.promptFragment}`);
  });

  it('does not double a trailing comma the user typed', () => {
    expect(applyScenePreset('A lemon tart, ', slate)).toBe(`A lemon tart, ${slate.promptFragment}`);
  });

  it('swaps one scene for another, keeping the rest of the prompt', () => {
    const withSlate = applyScenePreset('A lemon tart', slate);
    expect(applyScenePreset(withSlate, picnic)).toBe(`A lemon tart, ${picnic.promptFragment}`);
  });

  it('removes the scene when none is picked', () => {
    expect(applyScenePreset(applyScenePreset('A lemon tart', slate), undefined)).toBe('A lemon tart');
    expect(applyScenePreset(slate.promptFragment, undefined)).toBe('');
  });

  it('keeps words typed after the fragment when swapping', () => {
    const edited = `A lemon tart, ${slate.promptFragment}, overhead shot`;
    expect(applyScenePreset(edited, picnic)).toBe(`A lemon tart, overhead shot, ${picnic.promptFragment}`);
  });
});

describe('applyScenePreset with fragments typed by hand', () => {
  const slate = preset('wet-slate');
  const kitchen = preset('kitchen-counter');
  const picnic = preset('picnic');

  it('cuts every scene, so only the picked one remains', () => {
    const prompt = `A tart, ${slate.promptFragment}, ${kitchen.promptFragment}`;
    const next = applyScenePreset(prompt, picnic);
    expect(next).toBe(`A tart, ${picnic.promptFragment}`);
    expect(appliedScenePreset(next)?.id).toBe('picnic');
  });

  it('cuts a repeated fragment and rejoins the words around it', () => {
    expect(applyScenePreset(`A, ${slate.promptFragment}, B ${slate.promptFragment}`, undefined)).toBe('A, B');
    expect(applyScenePreset(`A tart ${slate.promptFragment}, overhead`, picnic)).toBe(
      `A tart, overhead, ${picnic.promptFragment}`
    );
  });
});

describe('appliedScenePreset', () => {
  it('finds the scene the prompt carries', () => {
    expect(appliedScenePreset(applyScenePreset('A tart', preset('picnic')))?.id).toBe('picnic');
  });

  it('finds none once the fragment is edited away', () => {
    expect(appliedScenePreset('A tart on a red gingham blanket')).toBeUndefined();
  });
});
