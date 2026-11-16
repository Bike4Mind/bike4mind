import { Resource } from 'sst';

/**
 * Origin of the ChatCompletion service with no trailing slash, for callers that append a path.
 * The hosted link ends in a slash when the service has its own domain (`https://<host>/`) and has
 * none otherwise, and the service's router does not match a doubled slash.
 */
export function chatCompletionBaseUrl(): string {
  return Resource.ChatCompletion.url.replace(/\/+$/, '');
}
