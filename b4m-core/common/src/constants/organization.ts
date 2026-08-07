/**
 * Organization seat-limit policy - the floor and ceiling every seat change is bound by.
 *
 * Lives in common (not the app's subscriptions constants) because the ceiling has to be
 * enforced in the persistence layer too: `OrganizationModel.addMemberRaisingSeats` clamps
 * the auto-raise against MAX, and packages/database cannot import from apps/client. The app
 * re-exports these from `lib/subscriptions/constants` so existing importers stay unchanged.
 */

/** Paid-plan minimum seats (Stripe path). Admin grants may go smaller (see ADMIN_MIN_SEATS). */
export const ORGANIZATION_SUBSCRIPTION_MIN_SEATS = 4;

/**
 * Hard ceiling on org seats. Both `validateSeatChange` and the unattended partner-rule
 * auto-raise (`addMemberRaisingSeats`) clamp to this, so a full org falls through to the
 * at-capacity path instead of growing a seat floor that no `setSeats` value can satisfy (#1424).
 */
export const ORGANIZATION_SUBSCRIPTION_MAX_SEATS = 100;
