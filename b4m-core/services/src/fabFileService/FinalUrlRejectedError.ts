/** Thrown by an `assertFinalUrl` predicate when the page a fetch actually landed on is not acceptable. */
export class FinalUrlRejectedError extends Error {
  constructor() {
    super('The page this link resolved to is not one this source rule covers');
    this.name = 'FinalUrlRejectedError';
  }
}
