/**
 * Marks an overlay that the tutorial's coach card hides under while it is open, such as the side nav drawn over
 * the page on a narrow screen. The card stays up when its own anchor sits inside the overlay.
 */
export const COACH_COVER_ATTR = 'data-coach-cover';
export const COACH_COVER_SELECTOR = `[${COACH_COVER_ATTR}="true"]`;

export const coachCover = (open: boolean) => ({ [COACH_COVER_ATTR]: open ? 'true' : undefined });

/** Marks a bar fixed to the top of a narrow screen, such as the header's menu button row. A card docked to the top sits below it. */
export const COACH_TOP_BAR_ATTR = 'data-coach-top-bar';
export const COACH_TOP_BAR_SELECTOR = `[${COACH_TOP_BAR_ATTR}="true"]`;
export const coachTopBar = { [COACH_TOP_BAR_ATTR]: 'true' };
