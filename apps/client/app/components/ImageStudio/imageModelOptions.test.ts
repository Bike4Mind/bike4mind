import { describe, expect, it } from 'vitest';
import { IMAGE_MODEL_STRENGTHS, ImageModels, usdToCredits } from '@bike4mind/common';
import { estimateImageUsd } from '@bike4mind/services/imageCost';
import {
  EMPTY_IMAGE_INTENT,
  imageAspectRatioOptions,
  imageCreditsPerImage,
  imageFieldProblems,
  imageModelCards,
  imageModelWhyNot,
  imageSizeOptions,
  pickDefaultImageModel,
} from './imageModelOptions';

const available = [
  { id: ImageModels.FLUX_KONTEXT_PRO, name: 'FLUX Kontext Pro' },
  { id: ImageModels.FLUX_PRO_ULTRA, name: 'FLUX Ultra' },
  { id: ImageModels.GEMINI_3_1_FLASH_IMAGE, name: 'Nano Banana 2' },
  { id: ImageModels.GPT_IMAGE_1_5, name: 'GPT Image 1.5' },
  { id: 'not-an-image-model', name: 'Unknown' },
];

const cardOf = (cards: ReturnType<typeof imageModelCards>, id: string) => {
  const card = cards.find(candidate => candidate.id === id);
  if (!card) throw new Error(`no card for ${id}`);
  return card;
};

describe('imageModelCards', () => {
  it('keeps catalog models only, ranked for the request, with the name, provider, strength and modes', () => {
    const cards = imageModelCards(available, EMPTY_IMAGE_INTENT);
    expect(cards.map(card => card.id)).toEqual([
      ImageModels.GPT_IMAGE_1_5,
      ImageModels.GEMINI_3_1_FLASH_IMAGE,
      ImageModels.FLUX_PRO_ULTRA,
      ImageModels.FLUX_KONTEXT_PRO,
    ]);
    expect(cardOf(cards, ImageModels.GPT_IMAGE_1_5)).toMatchObject({
      name: 'GPT Image 1.5',
      provider: 'OpenAI',
      strength: IMAGE_MODEL_STRENGTHS[ImageModels.GPT_IMAGE_1_5],
      outputNoun: 'image',
      modes: ['Generate', 'Edit'],
      pickedFor: 'sharp detail and text',
      whyNotCode: null,
      unavailableReason: null,
      mismatchReason: null,
    });
  });

  it('says what each fitting model was picked for, naming attached references', () => {
    const intent = { ...EMPTY_IMAGE_INTENT, references: [{ fileId: 'f1', fileName: 'mug.png' }] };
    const [top] = imageModelCards(available, intent);
    expect(top).toMatchObject({ id: ImageModels.GPT_IMAGE_1_5, pickedFor: 'sharp detail and text + reference' });
  });

  it('ranks a model that cannot honour the request below the ones that can, with the validator code', () => {
    const cards = imageModelCards(available, { ...EMPTY_IMAGE_INTENT, size: '1024x1536' });
    expect(cards.map(card => card.id)).toEqual([
      ImageModels.GPT_IMAGE_1_5,
      ImageModels.GEMINI_3_1_FLASH_IMAGE,
      ImageModels.FLUX_PRO_ULTRA,
      ImageModels.FLUX_KONTEXT_PRO,
    ]);
    expect(cardOf(cards, ImageModels.GEMINI_3_1_FLASH_IMAGE)).toMatchObject({
      pickedFor: null,
      whyNotCode: 'unsupported_size',
      mismatchReason: expect.any(String),
    });
  });

  it('makes an edit-only model unavailable with its why-not reason', () => {
    const kontext = cardOf(imageModelCards(available, EMPTY_IMAGE_INTENT), ImageModels.FLUX_KONTEXT_PRO);
    expect(kontext.unavailableReason).toEqual(expect.any(String));
    expect(kontext.unavailableReason).not.toBe('');
  });

  it('makes a model whose job provider is not wired temporarily unavailable', () => {
    const ultra = cardOf(imageModelCards(available, EMPTY_IMAGE_INTENT), ImageModels.FLUX_PRO_ULTRA);
    expect(ultra.unavailableReason).toBe('Temporarily unavailable in Studio.');
  });

  it('makes a retired model that the job route serves under its successor unavailable', () => {
    const [retired] = imageModelCards([{ id: ImageModels.GPT_IMAGE_1, name: 'GPT Image 1' }], EMPTY_IMAGE_INTENT);
    expect(retired.unavailableReason).toMatch(/Retired/);
  });

  it('greys a model that cannot honour the request, keeping it pickable', () => {
    const intent = { ...EMPTY_IMAGE_INTENT, size: '1024x1536' };
    const gemini = cardOf(imageModelCards(available, intent), ImageModels.GEMINI_3_1_FLASH_IMAGE);
    expect(gemini.unavailableReason).toBeNull();
    expect(gemini.mismatchReason).toBe(imageModelWhyNot(ImageModels.GEMINI_3_1_FLASH_IMAGE, intent));
    expect(gemini.mismatchReason).toEqual(expect.any(String));
  });

  it('prices one image with the hold cost tables', () => {
    const card = cardOf(imageModelCards(available, EMPTY_IMAGE_INTENT), ImageModels.GEMINI_3_1_FLASH_IMAGE);
    expect(card.creditsPerOutput).toBe(
      usdToCredits(
        estimateImageUsd(ImageModels.GEMINI_3_1_FLASH_IMAGE, 1, { model: ImageModels.GEMINI_3_1_FLASH_IMAGE })
      )
    );
  });
});

describe('imageCreditsPerImage', () => {
  it('prices the chosen quality on a model that takes it', () => {
    const low = imageCreditsPerImage(ImageModels.GPT_IMAGE_1_5, { ...EMPTY_IMAGE_INTENT, quality: 'low' });
    const high = imageCreditsPerImage(ImageModels.GPT_IMAGE_1_5, { ...EMPTY_IMAGE_INTENT, quality: 'high' });
    expect(low).not.toBeNull();
    expect(high).toBeGreaterThan(low ?? Infinity);
  });
});

describe('imageFieldProblems', () => {
  it('keys each value the model does not take to the field that holds it', () => {
    const intent = {
      ...EMPTY_IMAGE_INTENT,
      aspectRatio: '16:9',
      size: '1024x1536',
      references: [{ fileId: 'f1', fileName: 'a.png' }],
    };
    const problems = imageFieldProblems(ImageModels.GEMINI_3_1_FLASH_IMAGE, intent);
    expect(problems.size).toEqual(expect.any(String));
    expect(imageFieldProblems(ImageModels.GPT_IMAGE_1_5, intent)).toEqual({ aspect: expect.any(String) });
  });
});

describe('pickDefaultImageModel', () => {
  it('opens on the top-ranked model that can run', () => {
    expect(pickDefaultImageModel(imageModelCards(available, EMPTY_IMAGE_INTENT))).toBe(ImageModels.GPT_IMAGE_1_5);
  });

  it('falls back to the first runnable model, and to none when nothing can run', () => {
    const cards = imageModelCards(
      [
        { id: ImageModels.FLUX_KONTEXT_PRO, name: 'Kontext' },
        { id: ImageModels.GEMINI_3_PRO_IMAGE, name: 'Nano Banana Pro' },
      ],
      EMPTY_IMAGE_INTENT
    );
    expect(pickDefaultImageModel(cards)).toBe(ImageModels.GEMINI_3_PRO_IMAGE);
    expect(pickDefaultImageModel(cards.filter(card => card.id === ImageModels.FLUX_KONTEXT_PRO))).toBeUndefined();
  });
});

describe('size and aspect ratio options', () => {
  it('lists the named sizes of a preset model and none for a fixed one', () => {
    expect(imageSizeOptions(ImageModels.GPT_IMAGE_1_5)).toContain('1024x1536');
    expect(imageSizeOptions(ImageModels.GEMINI_3_1_FLASH_IMAGE)).toEqual([]);
  });

  it('lists the ratios inside a ranged model and none for a model without ratios', () => {
    const ultra = imageAspectRatioOptions(ImageModels.FLUX_PRO_ULTRA);
    expect(ultra).toContain('16:9');
    expect(ultra).toContain('21:9');
    expect(imageAspectRatioOptions(ImageModels.GPT_IMAGE_1_5)).toEqual([]);
  });
});
