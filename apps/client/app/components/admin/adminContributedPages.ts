import { Puzzle } from 'lucide-react';
import { isFullAdmin } from '@bike4mind/common';
import type { PremiumRouteDescriptor } from '../../premiumContract';
import type { SidebarPageLink, SidebarSection } from './adminSidebarConfig';

/** What the admin shell needs of a contributed page: the descriptor's path and its sidebar entry. */
export type ContributedAdminPage = Pick<PremiumRouteDescriptor, 'path' | 'adminPage'>;

/**
 * Contributed pages are open to full admins only: they are not in DELEGATED_ADMIN_TAB_PERMISSIONS,
 * so there is no permission a delegate could hold that opens one.
 */
export const canOpenContributedAdminPage = (user: Parameters<typeof isFullAdmin>[0]): boolean => isFullAdmin(user);

/** `/admin/ext/reports/weekly` -> `admin-ext-reports-weekly-btn`, in the style of the other sidebar testids. */
export const contributedPageTestId = (path: string): string => {
  const slug = path
    .replace(/^\/admin\/ext\//i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `admin-ext-${slug}-btn`;
};

/**
 * `sections` with each contributed page added after the items of the section it names, in the order
 * given. Returns `sections` itself when there is nothing to add, so the sidebar is unchanged.
 */
export const withContributedPages = (
  sections: SidebarSection[],
  pages: readonly ContributedAdminPage[]
): SidebarSection[] => {
  if (pages.length === 0) return sections;
  const linksBySection = new Map<string, SidebarPageLink[]>();
  for (const { path, adminPage } of pages) {
    if (!adminPage) continue;
    const link: SidebarPageLink = {
      Icon: adminPage.Icon ?? Puzzle,
      label: adminPage.label,
      path,
      testid: adminPage.testId ?? contributedPageTestId(path),
    };
    linksBySection.set(adminPage.section, [...(linksBySection.get(adminPage.section) ?? []), link]);
  }
  return sections.map(section => {
    const links = linksBySection.get(section.key);
    return links ? { ...section, pages: [...(section.pages ?? []), ...links] } : section;
  });
};
