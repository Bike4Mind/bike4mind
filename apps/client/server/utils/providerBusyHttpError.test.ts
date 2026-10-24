import { ProviderBusyError } from '@bike4mind/services';
import { describe, expect, it } from 'vitest';
import { httpErrorToResponse } from '@server/middlewares/errorHandler';
import { providerBusyHttpError } from './providerBusyHttpError';

describe('providerBusyHttpError', () => {
  it('becomes a 429 whose Retry-After carries the provider wait', () => {
    const response = httpErrorToResponse(
      providerBusyHttpError(new ProviderBusyError('elevenlabs', 'slots_exhausted', 5)),
      'req-1'
    );

    expect(response.status).toBe(429);
    expect(response.headers['Retry-After']).toBe('5');
  });
});
