import { ModelBackend } from '@bike4mind/common';
import type { AdapterFamily, ModelDispatchProfile, ModelRecord } from '@bike4mind/common';

/**
 * The dispatch group for a family whose request builder shapes its payload from
 * the provider's own contract and reads nothing out of the profile (Bedrock,
 * Gemini, xAI, Ollama, and the image/speech backends). Promotion still requires
 * a profile, and stating it explicitly is the claim that matters: "this build
 * knows how to shape a request for this family", as opposed to OpenAI, where it
 * does not know without being told which token parameter the model takes.
 */
const PROVIDER_NATIVE_PROFILE: ModelDispatchProfile = { maxTokensParam: 'max_tokens', toolTransport: 'native' };

/** Anthropic's Messages API: max_tokens, tools in the provider's own field. */
const ANTHROPIC_MESSAGES_PROFILE: ModelDispatchProfile = { maxTokensParam: 'max_tokens', toolTransport: 'native' };

/** Cross-region inference prefixes; the vendor segment follows them. */
const BEDROCK_REGION_PREFIX = /^(us|eu|apac|global)\./;

/**
 * The sec 5.4 prefix map. Jurassic and Titan are deliberately absent: both are
 * legacy families with no new members, so an unseen `ai21.` or `amazon.` id is a
 * human decision rather than something to route automatically.
 */
const BEDROCK_FAMILY_BY_VENDOR: Readonly<Record<string, AdapterFamily>> = {
  anthropic: 'bedrock-anthropic',
  meta: 'bedrock-llama',
  deepseek: 'bedrock-deepseek',
  // BOTH spellings, because AWS ships both: k2.5 is `moonshotai.` and
  // k2-thinking is `moonshot.` on bedrock-runtime. Mapping only one would leave
  // every discovered model on the other prefix permanently un-dispatchable.
  moonshot: 'bedrock-moonshot',
  moonshotai: 'bedrock-moonshot',
};

/**
 * Moonshot direct. Its own constant rather than PROVIDER_NATIVE_PROFILE because
 * Moonshot deprecated `max_tokens` in favor of `max_completion_tokens`, which is
 * exactly the kind of thing the profile exists to record - and exactly what
 * kimiBackend sends.
 */
const KIMI_PROFILE: ModelDispatchProfile = { maxTokensParam: 'max_completion_tokens', toolTransport: 'chat' };

/** Backends whose family is the backend, with a request shape this build fixes. */
const FAMILY_BY_BACKEND: Readonly<Partial<Record<ModelBackend, AdapterFamily>>> = {
  [ModelBackend.Anthropic]: 'anthropic-messages',
  [ModelBackend.Gemini]: 'gemini',
  [ModelBackend.XAI]: 'xai',
  [ModelBackend.Ollama]: 'ollama',
  [ModelBackend.BFL]: 'bfl',
  [ModelBackend.LocalImage]: 'local-image',
  [ModelBackend.AWS]: 'aws',
};

export type ResolvedDispatch = Pick<ModelRecord, 'adapterFamily' | 'dispatchProfile'>;

/**
 * Fill the dispatch group for a model no catalog row covers yet. Satisfies the
 * service's `DispatchResolver` contract; the drivers inject it so a model in an
 * already-dispatched family can become invocable without a code change.
 *
 * MUST STAY IN SYNC WITH getLlmByModel and the request builders: this may only
 * claim a family whose requests this build actually shapes correctly. Where the
 * shape cannot be derived from the id and the backend alone it returns the
 * family without a profile (or null), which leaves the model metadata-only -
 * the fail-closed side of sec 5.4.
 */
export function resolveDispatchForRecord(record: Pick<ModelRecord, 'id' | 'backend'>): ResolvedDispatch | null {
  if (record.backend === ModelBackend.Bedrock) {
    const withoutRegion = record.id.replace(BEDROCK_REGION_PREFIX, '');
    const dot = withoutRegion.indexOf('.');
    // Same guard as inferVendor (b4m-core/common/src/modelCatalog.ts): an id with
    // no vendor segment names no family, and slicing on -1 would invent one.
    if (dot <= 0) return null;
    const adapterFamily = BEDROCK_FAMILY_BY_VENDOR[withoutRegion.slice(0, dot)];
    return adapterFamily ? { adapterFamily, dispatchProfile: PROVIDER_NATIVE_PROFILE } : null;
  }

  // OpenAI is the one family whose request shape the id does not reveal: the
  // GPT-5 generation takes max_completion_tokens and routes tools through
  // /v1/responses, the GPT-4 generation does neither, and a new id looks like
  // both. Naming the family still buys something - the model reports as
  // "no dispatch profile" instead of "no adapter family", which is the queue
  // item a human can actually close.
  if (record.backend === ModelBackend.OpenAI) return { adapterFamily: 'openai-chat' };

  if (record.backend === ModelBackend.Anthropic) {
    return { adapterFamily: 'anthropic-messages', dispatchProfile: ANTHROPIC_MESSAGES_PROFILE };
  }

  // Moonshot direct: family and profile are both known, but the profile is not the
  // provider-native one (see KIMI_PROFILE).
  if (record.backend === ModelBackend.Kimi) {
    return { adapterFamily: 'kimi', dispatchProfile: KIMI_PROFILE };
  }

  const adapterFamily = FAMILY_BY_BACKEND[record.backend];
  return adapterFamily ? { adapterFamily, dispatchProfile: PROVIDER_NATIVE_PROFILE } : null;
}
