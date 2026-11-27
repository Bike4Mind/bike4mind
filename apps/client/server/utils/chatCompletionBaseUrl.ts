import { Resource } from 'sst';

/**
 * Origin of the ChatCompletion service with no trailing slash, for callers that append a path.
 * The hosted link ends in a slash when the service has its own domain (`https://<host>/`) and has
 * none otherwise, and the service's router does not match a doubled slash.
 * CHAT_COMPLETION_ORIGIN_URL is set only on previews that share one load balancer, where the
 * service has none of its own and so links no URL (infra/chatCompletion.ts).
 */
export function chatCompletionBaseUrl(): string {
  return (process.env.CHAT_COMPLETION_ORIGIN_URL || Resource.ChatCompletion.url).replace(/\/+$/, '');
}
