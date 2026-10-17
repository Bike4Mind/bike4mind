import { DATA_LAKE } from './dataLakeBranding';

export const GITHUB_LAKE_ADMIN_FLAG = 'EnableDataLakeGitHub';
export const GITHUB_ORG_ONLY_REASON = `GitHub repositories can only feed an organization ${DATA_LAKE}. Switch to your team account in the account switcher in the profile menu, then connect a repository.`;
export const GITHUB_ORG_MANAGER_ONLY_REASON = 'Only an organization owner or manager can connect a GitHub repository.';

export const orgIdOfAccount = (account: { id: string; personal: boolean } | null | undefined): string | undefined =>
  account && !account.personal ? account.id : undefined;
