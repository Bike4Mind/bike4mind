import { Agent } from 'undici';
import type OpenAI from 'openai';

type SdkFetchOptions = NonNullable<ConstructorParameters<typeof OpenAI>[0]>['fetchOptions'];

let agent: Agent | undefined;

// Node's global dispatcher drops idle sockets after 4 s; a longer idle timeout lets consecutive chat
// turns reuse the provider connection.
export function providerDispatcher(): Agent {
  agent ??= new Agent({ keepAliveTimeout: 60_000 });
  return agent;
}

export function providerFetchOptions(): NonNullable<SdkFetchOptions> {
  // Cast: the SDK types `dispatcher` with undici-types' Dispatcher (MergedRequestInit), which the
  // npm undici Agent does not structurally match; at runtime Node's fetch accepts it.
  return { dispatcher: providerDispatcher() } as unknown as NonNullable<SdkFetchOptions>;
}
