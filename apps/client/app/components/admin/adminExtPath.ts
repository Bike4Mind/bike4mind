/** Every contributed admin page lives under this prefix, so it can never collide with a core admin route. */
export const ADMIN_EXT_PATH_PREFIX = '/admin/ext/';

/**
 * Whether `pathname` is inside the contributed admin page namespace (and so is never a core admin
 * route). Case-insensitive because the router matches paths that way, so a guard keyed on this is
 * not sidestepped by typing the URL in another case.
 */
export const isAdminExtPath = (pathname: string): boolean => pathname.toLowerCase().startsWith(ADMIN_EXT_PATH_PREFIX);

/** `/admin/ext/reports/weekly` -> `admin-ext-reports-weekly-btn`, in the style of the other sidebar testids. */
export const contributedPageTestId = (path: string): string => {
  const slug = path
    .replace(/^\/admin\/ext\//i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `admin-ext-${slug}-btn`;
};
