export const FILE_URL_WINDOW_SECONDS = 30 * 60;
/** Lifetime from the window start (s): a link always has at least one full window left when handed out. */
export const FILE_URL_TTL_SECONDS = 2 * FILE_URL_WINDOW_SECONDS;

/**
 * Start of the signing window containing `now`. Links signed as of this instant are identical for
 * every read within the window, so a browser can serve the file from cache instead of re-fetching it.
 */
export const fileUrlSigningDate = (now: Date = new Date()): Date => {
  const windowMs = FILE_URL_WINDOW_SECONDS * 1000;
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
};
