/**
 * Page-load baseline for the deploy identity, in memory on purpose: a reload is exactly what
 * clears it, so `sessionStorage` would leave the banner stuck on after the reload it asks for.
 */
let pageLoadRevision: string | undefined;

/**
 * Records the first revision this page load sees. Returns true only when a later response names a
 * different revision, i.e. a deploy happened under this tab. Undefined/empty never moves the
 * baseline - a stage with no provenance must not look like a deploy.
 */
export const observeDeployedRevision = (revision: string | undefined): boolean => {
  if (!revision) return false;
  if (pageLoadRevision === undefined) {
    pageLoadRevision = revision;
    return false;
  }
  return revision !== pageLoadRevision;
};

/** Test-only: forget the baseline so a suite can exercise a fresh page load. */
export const resetDeployedRevisionBaseline = (): void => {
  pageLoadRevision = undefined;
};
