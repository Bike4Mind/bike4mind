import { createHash } from 'crypto';

// Must stay identical to toProviderEndUserId in b4m-core/llm-adapters/src/endUserId.ts, the value
// sent to Anthropic and OpenAI; kept local so the user model does not load the adapter package.
export function providerEndUserIdFor(userId: string): string {
  return createHash('sha256').update(String(userId).trim()).digest('hex');
}
