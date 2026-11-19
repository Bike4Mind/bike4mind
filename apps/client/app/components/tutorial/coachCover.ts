/**
 * Marks an overlay that the tutorial's coach card hides under while it is open, such as the side nav drawn over
 * the page on a narrow screen. The card stays up when its own anchor sits inside the overlay.
 */
export const COACH_COVER_ATTR = 'data-coach-cover';
export const COACH_COVER_SELECTOR = `[${COACH_COVER_ATTR}="true"]`;

export const coachCover = (open: boolean) => ({ [COACH_COVER_ATTR]: open ? 'true' : undefined });
