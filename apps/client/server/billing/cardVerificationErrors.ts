export class CardVerificationRefused extends Error {
  constructor(
    readonly code: 'unavailable' | 'not_found' | 'ineligible' | 'unsupported_card' | 'risk_refused' | 'card_in_use'
  ) {
    super(`Card verification ${code}`);
  }
}
