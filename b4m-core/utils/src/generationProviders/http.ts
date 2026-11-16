import { ProviderOutputUnavailableError, readBoundedResponse } from './types';

/** The body as JSON when it parses, else the raw text, so an error page still reaches the logs and `raw`. */
export const readJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const assertHttps = (url: URL): void => {
  if (url.protocol !== 'https:') throw new Error('untrusted_output_url: https required');
};

/**
 * Downloads a provider's pre-signed delivery URL, never sending our credentials, under a size cap enforced while
 * streaming. One redirect is followed and both hops must be https. An expired (403) or purged (404, 410) link
 * throws ProviderOutputUnavailableError.
 */
export const downloadDeliveryUrl = async (value: string, maxBytes: number, signal: AbortSignal): Promise<Buffer> => {
  const url = new URL(value);
  assertHttps(url);
  let response = await fetch(url, { redirect: 'manual', signal });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (!location) throw new Error('redirect_without_location');
    const target = new URL(location, url);
    assertHttps(target);
    await response.body?.cancel();
    response = await fetch(target, { redirect: 'error', signal });
  }
  if ([403, 404, 410].includes(response.status)) throw new ProviderOutputUnavailableError(response.status);
  if (!response.ok) throw new Error(`download_http_${response.status}`);
  return readBoundedResponse(response, maxBytes);
};
