/** Campaign-touch cohort keys shared by the acquisition server module and the admin Analytics page. */

export type AcquisitionTouchKind = 'first' | 'last';

export const ACQUISITION_UNATTRIBUTED_KEY = 'unattributed';
/** Stands in for an absent medium or campaign, in both the row and its key. */
export const ACQUISITION_NONE = '(none)';

type StoredTouch = { source?: unknown; medium?: unknown; campaign?: unknown } | null | undefined;
export type StoredAcquisition = { firstTouch?: StoredTouch; lastTouch?: StoredTouch } | null | undefined;

export type AttributedTouch = { key: string; source: string; medium: string; campaign: string };

const fold = (value: unknown): string => (typeof value === 'string' ? value.trim().toLowerCase() : '');

/**
 * The cohort a signup falls in for `touch`, or null when it has no usable campaign touch. Either touch
 * falls back to the other when it alone is missing, so a signup is attributed under both or neither.
 * Verified and OAuth touches are not campaign touches and never attribute a signup here.
 */
export function attributedTouch(acquisition: StoredAcquisition, touch: AcquisitionTouchKind): AttributedTouch | null {
  const stored =
    touch === 'first'
      ? (acquisition?.firstTouch ?? acquisition?.lastTouch)
      : (acquisition?.lastTouch ?? acquisition?.firstTouch);
  const source = fold(stored?.source);
  if (!source) return null;
  const medium = fold(stored?.medium) || ACQUISITION_NONE;
  const campaign = fold(stored?.campaign) || ACQUISITION_NONE;
  return { key: `${source}|${medium}|${campaign}`, source, medium, campaign };
}
