/** A premium package that owns tutorials. Holds no tutorial content, only where an admin manages them. */
export interface TutorialOwner {
  owner: string;
  label: string;
  /** The owner's API prefix; core reads `<adminBase>/summary`. */
  adminBase: string;
  /** The page where the owner's tutorials are edited. */
  adminHref: string;
}

/** Throws on a malformed entry, so a bad contribution fails at module load rather than serving a broken link. */
export function assertTutorialOwners(owners: readonly TutorialOwner[]): TutorialOwner[] {
  const seen = new Set<string>();
  for (const entry of owners) {
    const { owner, label, adminBase, adminHref } = entry ?? ({} as Partial<TutorialOwner>);
    if (!owner || typeof owner !== 'string') throw new Error('tutorialOwners: entry without an owner');
    if (seen.has(owner)) throw new Error(`tutorialOwners: duplicate owner "${owner}"`);
    seen.add(owner);
    if (!label || typeof label !== 'string') throw new Error(`tutorialOwners: owner "${owner}" has no label`);
    if (typeof adminBase !== 'string' || !adminBase.startsWith('/api/')) {
      throw new Error(`tutorialOwners: owner "${owner}" adminBase must start with /api/`);
    }
    if (typeof adminHref !== 'string' || !adminHref.startsWith('/') || adminHref.startsWith('//')) {
      throw new Error(`tutorialOwners: owner "${owner}" adminHref must be a path starting with /`);
    }
  }
  return [...owners];
}
