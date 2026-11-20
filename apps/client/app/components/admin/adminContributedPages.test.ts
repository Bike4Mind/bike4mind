import { describe, expect, it } from 'vitest';
import { Puzzle, Sparkles } from 'lucide-react';
import { SIDEBAR_SECTIONS } from './adminSidebarConfig';
import { contributedPageTestId } from './adminExtPath';
import { canOpenContributedAdminPage, withContributedPages, type ContributedAdminPage } from './adminContributedPages';

const page = (path: string, adminPage: NonNullable<ContributedAdminPage['adminPage']>): ContributedAdminPage => ({
  path,
  adminPage,
});

describe('withContributedPages', () => {
  it('returns the very same sections when there is nothing to add', () => {
    expect(withContributedPages(SIDEBAR_SECTIONS, [])).toBe(SIDEBAR_SECTIONS);
  });

  it('puts each page in the section it names, in the order given, after the section items', () => {
    const sections = withContributedPages(SIDEBAR_SECTIONS, [
      page('/admin/ext/second', { section: 'money', label: 'Second' }),
      page('/admin/ext/other', { section: 'ai', label: 'Other' }),
      page('/admin/ext/first', { section: 'money', label: 'First' }),
    ]);

    const money = sections.find(section => section.key === 'money')!;
    expect(money.pages?.map(link => link.label)).toEqual(['Second', 'First']);
    expect(sections.find(section => section.key === 'ai')?.pages?.map(link => link.label)).toEqual(['Other']);
    expect(money.items).toEqual(SIDEBAR_SECTIONS.find(section => section.key === 'money')!.items);
  });

  it('keeps the section order and leaves untouched sections as the same objects', () => {
    const sections = withContributedPages(SIDEBAR_SECTIONS, [page('/admin/ext/x', { section: 'money', label: 'X' })]);

    expect(sections.map(section => section.key)).toEqual(SIDEBAR_SECTIONS.map(section => section.key));
    sections.forEach((section, index) => {
      if (section.key !== 'money') expect(section).toBe(SIDEBAR_SECTIONS[index]);
    });
  });

  it('does not mutate the static sections', () => {
    withContributedPages(SIDEBAR_SECTIONS, [page('/admin/ext/x', { section: 'money', label: 'X' })]);

    expect(SIDEBAR_SECTIONS.every(section => section.pages === undefined)).toBe(true);
  });

  it('links to the literal path with the given icon and testid', () => {
    const [link] = withContributedPages(SIDEBAR_SECTIONS, [
      page('/admin/ext/reports', { section: 'ai', label: 'Reports', Icon: Sparkles, testId: 'reports-link' }),
    ]).find(section => section.key === 'ai')!.pages!;

    expect(link).toEqual({ Icon: Sparkles, label: 'Reports', path: '/admin/ext/reports', testid: 'reports-link' });
  });

  it('falls back to a default icon and a testid derived from the path', () => {
    const [link] = withContributedPages(SIDEBAR_SECTIONS, [
      page('/admin/ext/reports/weekly', { section: 'ai', label: 'Weekly' }),
    ]).find(section => section.key === 'ai')!.pages!;

    expect(link.Icon).toBe(Puzzle);
    expect(link.testid).toBe('admin-ext-reports-weekly-btn');
  });

  it('ignores a section key it does not know', () => {
    const unknown = { section: 'nope', label: 'X' } as unknown as NonNullable<ContributedAdminPage['adminPage']>;

    expect(withContributedPages(SIDEBAR_SECTIONS, [page('/admin/ext/x', unknown)])).toEqual(SIDEBAR_SECTIONS);
  });
});

describe('contributedPageTestId', () => {
  it.each([
    ['/admin/ext/reports', 'admin-ext-reports-btn'],
    ['/admin/ext/Reports/Weekly_View', 'admin-ext-reports-weekly-view-btn'],
    ['/admin/ext/a.b', 'admin-ext-a-b-btn'],
  ])('derives a stable testid from %s', (path, testid) => {
    expect(contributedPageTestId(path)).toBe(testid);
  });
});

describe('canOpenContributedAdminPage', () => {
  it('admits a full admin and no delegated admin, whatever permissions the delegate holds', () => {
    expect(canOpenContributedAdminPage({ isAdmin: true })).toBe(true);
    expect(canOpenContributedAdminPage({ adminPermissions: ['settings:manage', 'support:read'] })).toBe(false);
    expect(canOpenContributedAdminPage({})).toBe(false);
    expect(canOpenContributedAdminPage(null)).toBe(false);
  });
});
