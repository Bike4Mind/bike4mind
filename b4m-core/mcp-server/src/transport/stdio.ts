import { B4mApiError, createClient } from '@bike4mind/sdk';
import { buildGuardedUrl } from './guardedUrl';
import { OPERATIONS } from './operations';
import type { ApiTransport, TransportResponse } from './types';

export interface StdioTransportOptions {
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof fetch;
}

function headerRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

async function mapResponse(response: Response): Promise<TransportResponse> {
  const headers = headerRecord(response.headers);
  const base = { status: response.status, headers };
  const location = response.headers.get('location');
  if (response.status >= 300 && response.status < 400 && location) return { ...base, redirect: location };

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) return base;
  if (/json/i.test(response.headers.get('content-type') ?? '')) {
    try {
      return { ...base, json: JSON.parse(new TextDecoder().decode(bytes)) };
    } catch {
      // Declared JSON but not parseable: hand back the bytes rather than guess.
    }
  }
  return { ...base, bytes };
}

function mapApiError(error: B4mApiError): TransportResponse {
  const headers = headerRecord(error.headers);
  const location = error.headers.get('location');
  if (error.status >= 300 && error.status < 400 && location)
    return { status: error.status, headers, redirect: location };
  if (typeof error.body === 'object' && error.body !== null) return { status: error.status, headers, json: error.body };
  if (typeof error.body === 'string' && error.body) {
    return { status: error.status, headers, bytes: new TextEncoder().encode(error.body) };
  }
  return { status: error.status, headers };
}

/** Calls a deployment over HTTP with an API key. Contract routes go through the SDK, the rest through the guarded builder. */
export function createStdioTransport({ baseUrl, apiKey, fetch: fetchImpl }: StdioTransportOptions): ApiTransport {
  const client = createClient({ baseUrl, apiKey, fetch: fetchImpl });
  const doFetch = fetchImpl ?? globalThis.fetch;

  return {
    async call(operation, request = {}) {
      const def: (typeof OPERATIONS)[typeof operation] = OPERATIONS[operation];
      const { params, query, body, signal } = request;

      if ('sdkOperationId' in def) {
        try {
          // `never`: the operation id is picked at runtime, so the SDK's per-operation arg types cannot apply.
          const response = await client.raw(def.sdkOperationId, {
            params,
            query,
            body,
            signal,
            redirect: 'manual',
          } as never);
          return await mapResponse(response);
        } catch (error) {
          if (error instanceof B4mApiError) return mapApiError(error);
          throw error;
        }
      }

      const headers = new Headers();
      if (apiKey) headers.set('authorization', `Bearer ${apiKey}`);
      if (body !== undefined) headers.set('content-type', 'application/json');
      const response = await doFetch(buildGuardedUrl(baseUrl, def.path, params, query), {
        method: def.method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        redirect: 'manual',
      });
      return mapResponse(response);
    },
  };
}
