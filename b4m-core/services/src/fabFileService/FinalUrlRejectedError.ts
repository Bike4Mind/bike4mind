import { BadRequestError } from '@bike4mind/utils';

/** Thrown by an `assertFinalUrl` predicate when the page a fetch actually landed on is not acceptable. */
export class FinalUrlRejectedError extends BadRequestError {
  constructor() {
    super('The page this link resolved to is not one this source rule covers');
    this.name = 'FinalUrlRejectedError';
  }
}
