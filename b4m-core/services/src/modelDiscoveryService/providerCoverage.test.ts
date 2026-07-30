import { ModelBackend } from '@bike4mind/common';
import { resolveDispatchForRecord } from '@bike4mind/llm-adapters';
import { describe, expect, it } from 'vitest';
import { CREDENTIAL_OF_BACKEND } from './promotion';
import { testCredentials } from './__fixtures__/fakes';

/**
 * The seam that let the Kimi launch ship a provider the registry could not
 * maintain. Every TOTAL `Record<ModelBackend, X>` in the repo got its Kimi entry
 * because the compiler demanded one; every `Partial<Record<...>>` and
 * `Record<string, ...>` silently did not, and three of those live on the
 * discovery path. Nothing failed, because the seeded rows are already `active`
 * and `catalogWrite` only decides for new or still-`discovered` records - so the
 * gap only appears the first time discovery finds a model we did not seed, which
 * is precisely the case the registry exists to handle.
 *
 * These tests are deliberately written against `ModelBackend` itself rather than
 * against a list of providers, so the next provider added to the enum fails here
 * until it is threaded through both maps.
 */

const ALL_BACKENDS = Object.values(ModelBackend);

/**
 * Backends with no completion dispatch of their own. VoyageAI is embeddings-only
 * (`backendForAdapterFamily` throws for it by design), and the two image/speech
 * backends are dispatched but hold no *text* family - they are listed here so
 * that an addition to the enum is a decision recorded in this file rather than a
 * silent omission somewhere else.
 */
const NO_TEXT_DISPATCH: ReadonlySet<string> = new Set<string>([ModelBackend.VoyageAI]);

describe('every backend can be credentialed by discovery', () => {
  it.each(ALL_BACKENDS)('%s has a credential predicate', backend => {
    // Without an entry the promotion clause can never pass, so a discovered model
    // stays disabled forever and the admin queue blames the adapter instead.
    expect(Object.keys(CREDENTIAL_OF_BACKEND)).toContain(backend);
  });

  it('every predicate actually reads a credential, rather than being hardcoded true', () => {
    // A predicate that ignores its argument would satisfy the test above while
    // promoting models a deployment cannot call.
    const noCreds = testCredentials({
      openai: null,
      anthropic: null,
      gemini: null,
      xai: null,
      kimi: null,
      bfl: null,
      voyageai: null,
      ollama: null,
      imageGen: null,
      elevenlabs: null,
      awsIam: false,
    });
    for (const [backend, predicate] of Object.entries(CREDENTIAL_OF_BACKEND)) {
      expect(predicate(noCreds), `${backend} reports credentialed with no credentials at all`).toBe(false);
    }
  });
});

describe('every backend resolves an adapter family', () => {
  it.each(ALL_BACKENDS.filter(b => !NO_TEXT_DISPATCH.has(b)))('%s resolves a family', backend => {
    // A representative id per backend: the resolver reads the vendor segment for
    // Bedrock and the backend alone for everything else.
    const id = backend === ModelBackend.Bedrock ? 'anthropic.claude-sonnet-5' : 'some-model-id';
    expect(resolveDispatchForRecord({ id, backend })?.adapterFamily).toBeTruthy();
  });

  it('resolves both Bedrock Moonshot prefixes, which AWS spells inconsistently', () => {
    // k2.5 ships as `moonshotai.` and k2-thinking as `moonshot.` on
    // bedrock-runtime. Mapping one and not the other would leave every discovered
    // model on the missing prefix permanently un-dispatchable.
    for (const id of ['moonshotai.kimi-k2.5', 'moonshot.kimi-k2-thinking']) {
      expect(resolveDispatchForRecord({ id, backend: ModelBackend.Bedrock })).toEqual({
        adapterFamily: 'bedrock-moonshot',
        dispatchProfile: expect.objectContaining({ maxTokensParam: 'max_tokens' }),
      });
    }
  });

  it('gives Moonshot direct the max_completion_tokens profile its backend actually sends', () => {
    // The provider-native default is `max_tokens`, which Moonshot deprecated; a
    // promoted Kimi row carrying that profile would contradict kimiBackend.
    expect(resolveDispatchForRecord({ id: 'kimi-k3', backend: ModelBackend.Kimi })).toEqual({
      adapterFamily: 'kimi',
      dispatchProfile: expect.objectContaining({ maxTokensParam: 'max_completion_tokens' }),
    });
  });
});
