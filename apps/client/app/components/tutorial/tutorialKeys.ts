/** Every runner and admin query key starts with the host's `apiBase`, so two hosts never share a cache entry. */
export const tutorialProgressKey = (apiBase: string) => [apiBase, 'tutorial', 'progress'] as const;
export const tutorialModulesKey = (apiBase: string) => [apiBase, 'tutorial', 'modules'] as const;
export const tutorialAdminModulesKey = (apiBase: string) => [apiBase, 'tutorial', 'admin-modules'] as const;
export const tutorialSwitchKey = (apiBase: string) => [apiBase, 'tutorial', 'switch'] as const;
