export type AdminAiSkipReason =
  'disabled' | 'no_model' | 'budget' | 'call_cap' | 'provider_down' | 'invalid_output' | 'in_flight' | 'error';

/** An expected reason not to produce a suggestion; the runner reports it instead of throwing. */
export class AdminAiSkip extends Error {
  constructor(readonly reason: AdminAiSkipReason) {
    super(reason);
    this.name = 'AdminAiSkip';
  }
}
