import { BadRequestError } from '@bike4mind/utils';

/** A BadRequestError so the SPA route keeps its 400; the public v1 route reports it as a 502. */
export class AuthoringResultError extends BadRequestError {
  constructor(message: string) {
    super(message);
    this.name = 'AuthoringResultError';
  }
}
