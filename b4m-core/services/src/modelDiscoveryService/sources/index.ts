/**
 * Discovery sources (spec sec 5.5). Each one owns its provider's quirks - xAI's
 * two price constants, Gemini's pagination, Anthropic's markdown twins, Bedrock's
 * per-model entitlement fan-out - so the runner never has to know any of them.
 *
 * They are exported as factories, not instances: a source is data handed to
 * runModelDiscovery, and adding one must never mean editing the runner.
 *
 * `./http` is deliberately NOT re-exported: its helpers are named `text`,
 * `count` and `boolean`, which have no business in the public surface of
 * @bike4mind/services.
 */
export * from './aggregator';
export * from './anthropic';
export * from './anthropicDocs';
export * from './bedrock';
export * from './bfl';
export * from './elevenlabs';
export * from './gemini';
export * from './kimi';
export * from './litellm';
export * from './modelsDev';
export * from './ollama';
export * from './openai';
export * from './openaiDocs';
export * from './xai';
