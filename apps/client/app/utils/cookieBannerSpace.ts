/**
 * The cookie bar publishes its height here while it shows, and the notebook layout subtracts it from its own
 * height, so the bar sits below the app instead of over its bottom edge (the account button, the composer).
 * Kept apart from CookieConsentBanner so the layout does not load the consent code.
 */
export const COOKIE_BANNER_HEIGHT_VAR = '--cookie-banner-height';

export const COOKIE_BANNER_SPACE = `var(${COOKIE_BANNER_HEIGHT_VAR}, 0px)`;

/** The viewport height left above the cookie bar: the full height when it is not showing. */
export const VIEWPORT_ABOVE_COOKIE_BANNER = `calc(100dvh - ${COOKIE_BANNER_SPACE})`;
