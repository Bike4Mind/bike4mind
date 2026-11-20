import type { PremiumAdminPage, PremiumRouteDescriptor } from './premiumContract';
import { ADMIN_EXT_PATH_PREFIX, contributedPageTestId, isAdminExtPath } from './components/admin/adminExtPath';
import { ADMIN_SIDEBAR_SECTION_KEYS, isAdminSidebarSectionKey } from './components/admin/adminSidebarSectionKeys';

/** The router drops empty and `.` segments when it mounts a path, so `admin/x` and `//admin/x` are `/admin/x`. */
const isAdminUrlSpace = (path: string): boolean => {
  const normalized = `/${path
    .toLowerCase()
    .split('/')
    .filter(segment => segment !== '' && segment !== '.')
    .join('/')}`;
  return normalized === '/admin' || normalized.startsWith('/admin/');
};

export interface PremiumRoutePartition<T extends PremiumRouteDescriptor> {
  /** Bare under the root route: the URL is the authorization, so no gate and no ProviderBundle. */
  public: T[];
  /** Own chrome, gated by RestrictedPage, wrapped in ProviderBundle. */
  standalone: T[];
  /** Inside the notebook layout, gated by RestrictedPage. */
  appShell: T[];
  /** Inside the admin layout, behind its guard, with a link in the admin sidebar. */
  admin: (T & { adminPage: PremiumAdminPage })[];
}

const ADMIN_PAGE_EXCLUDED_FIELDS = [
  'public',
  'appShell',
  'edgeToEdge',
  'hostsWorkspace',
  'adminDashboard',
  'requireEntitlement',
  'requireFeatureTag',
  'fallbackPath',
] as const;

function assertValidAdminPage(
  descriptor: PremiumRouteDescriptor & { adminPage: PremiumAdminPage },
  seenPaths: Set<string>,
  seenTestIds: Set<string>
): void {
  const { path, adminPage } = descriptor;
  if (!isAdminExtPath(path) || path.length === ADMIN_EXT_PATH_PREFIX.length) {
    throw new Error(
      `Premium route ${path} sets adminPage outside ${ADMIN_EXT_PATH_PREFIX}; a contributed admin page lives under ${ADMIN_EXT_PATH_PREFIX}<name> so it cannot collide with a core admin route`
    );
  }
  if (
    path
      .slice(ADMIN_EXT_PATH_PREFIX.length)
      .split('/')
      .some(segment => ['', '.', '..'].includes(segment))
  ) {
    throw new Error(
      `Premium route ${path} sets adminPage on a path with an empty, "." or ".." segment; use a plain path under ${ADMIN_EXT_PATH_PREFIX}`
    );
  }
  if (path.includes('$')) {
    throw new Error(
      `Premium route ${path} sets adminPage on a parameterised path; the admin sidebar link points at the literal path`
    );
  }
  const combined = ADMIN_PAGE_EXCLUDED_FIELDS.filter(
    field => descriptor[field] !== undefined && descriptor[field] !== false
  );
  if (combined.length > 0) {
    throw new Error(
      `Premium route ${path} sets adminPage together with ${combined.join(', ')}; the admin layout's guard is the gate and the sidebar entry is the link`
    );
  }
  if (!isAdminSidebarSectionKey(adminPage.section)) {
    throw new Error(
      `Premium route ${path} sets adminPage.section to an unknown section; use one of ${ADMIN_SIDEBAR_SECTION_KEYS.join(', ')}`
    );
  }
  if (typeof adminPage.label !== 'string' || adminPage.label.trim() === '') {
    throw new Error(`Premium route ${path} sets adminPage without a label; the sidebar link needs one`);
  }
  const pathKey = path.toLowerCase();
  if (seenPaths.has(pathKey)) {
    throw new Error(`Premium route ${path} is declared twice with adminPage; each admin page needs its own path`);
  }
  seenPaths.add(pathKey);
  const testId = adminPage.testId ?? contributedPageTestId(path);
  if (seenTestIds.has(testId)) {
    throw new Error(`Premium route ${path} sets an adminPage whose sidebar test id ${testId} is already taken`);
  }
  seenTestIds.add(testId);
}

/**
 * Splits premium route descriptors by how the router mounts them, and refuses one that
 * asks for two things at once: a gate on a public route would be invisible to the reader
 * it blocks, the app shell's beforeLoad redirects a signed-out visitor before render, and
 * only the app shell has a sidebar to draw a hosted workspace's conversation list in.
 * An admin page is gated by the admin layout alone, and only an admin page may sit under
 * the admin URL space, so a contributed route never shadows or shares a core admin path.
 */
export function partitionPremiumRoutes<T extends PremiumRouteDescriptor>(
  descriptors: readonly T[]
): PremiumRoutePartition<T> {
  const partition: PremiumRoutePartition<T> = { public: [], standalone: [], appShell: [], admin: [] };
  const adminPaths = new Set<string>();
  const adminTestIds = new Set<string>();
  for (const descriptor of descriptors) {
    if (descriptor.adminPage !== undefined) {
      const adminDescriptor = descriptor as T & { adminPage: PremiumAdminPage };
      assertValidAdminPage(adminDescriptor, adminPaths, adminTestIds);
      partition.admin.push(adminDescriptor);
      continue;
    }
    if (isAdminUrlSpace(descriptor.path)) {
      throw new Error(
        `Premium route ${descriptor.path} is under /admin without adminPage; only an admin page may live under the admin URL space`
      );
    }
    if (descriptor.hostsWorkspace !== undefined && !descriptor.appShell) {
      throw new Error(
        `Premium route ${descriptor.path} sets hostsWorkspace without appShell; only the notebook layout draws a workspace's conversation list`
      );
    }
    if (descriptor.adminDashboard !== undefined && descriptor.path.includes('$')) {
      throw new Error(
        `Premium route ${descriptor.path} sets adminDashboard on a parameterised path; the admin dashboard card links to the literal path`
      );
    }
    if (descriptor.public) {
      const gated =
        descriptor.requireEntitlement !== undefined ||
        descriptor.requireFeatureTag !== undefined ||
        descriptor.fallbackPath !== undefined;
      if (gated) {
        throw new Error(
          `Premium route ${descriptor.path} is public and gated; a public route carries no requireEntitlement, requireFeatureTag or fallbackPath`
        );
      }
      if (descriptor.appShell) {
        throw new Error(
          `Premium route ${descriptor.path} is public and appShell; the app shell redirects signed-out visitors to login`
        );
      }
      partition.public.push(descriptor);
    } else if (descriptor.appShell) {
      partition.appShell.push(descriptor);
    } else {
      partition.standalone.push(descriptor);
    }
  }
  return partition;
}
