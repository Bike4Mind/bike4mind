/**
 * GitHub MCP Server - Repository Scope
 *
 * The set of repositories the user selected for AI access. The host passes the selection as a
 * JSON array of `owner/repo` names in GITHUB_SELECTED_REPOSITORIES and omits the variable when the
 * user has no saved selection, which leaves every repository available.
 */

import { z } from 'zod';
import { GITHUB_SELECTED_REPOSITORIES_ENV_KEY } from './constants.js';

export type RepoScope = { mode: 'all' } | { mode: 'selected'; repositories: ReadonlySet<string> };

export const ALL_REPOSITORIES: RepoScope = { mode: 'all' };

const selectedRepositoriesSchema = z.array(z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'expected "owner/repo"'));

// GitHub owner and repository names are case-insensitive.
const normalize = (fullName: string): string => fullName.toLowerCase();

/**
 * Parse the env value. A malformed value throws: guessing would either lock the user out or,
 * worse, silently widen access to every repository the token can reach.
 */
export function parseRepoScope(rawValue: string | undefined): RepoScope {
  if (rawValue === undefined) return ALL_REPOSITORIES;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    throw new Error(`${GITHUB_SELECTED_REPOSITORIES_ENV_KEY} must be a JSON array of "owner/repo" names`);
  }

  const result = selectedRepositoriesSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`${GITHUB_SELECTED_REPOSITORIES_ENV_KEY} is invalid: ${result.error.message}`);
  }
  return { mode: 'selected', repositories: new Set(result.data.map(normalize)) };
}

export function isRepositoryInScope(scope: RepoScope, fullName: string): boolean {
  return scope.mode === 'all' || scope.repositories.has(normalize(fullName));
}

export function filterToScope<T>(scope: RepoScope, items: readonly T[], getFullName: (item: T) => string): T[] {
  if (scope.mode === 'all') return [...items];
  return items.filter(item => isRepositoryInScope(scope, getFullName(item)));
}
