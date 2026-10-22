import { redirect } from '@tanstack/react-router';
import { useUser } from '@client/app/contexts/UserContext';
import { buildRedirectTo } from '@client/app/utils/authRedirect';
import { getGitHubLakeCallbackBootSearch } from '@client/app/utils/githubLakeCallbackSearch';
import { bootstrapSession } from '@client/app/utils/sessionBootstrap';

/**
 * beforeLoad for the GitHub lake callback route, which sits outside layoutRoute and so lacks its
 * session guard. GitHub's return is always a cold load, so without this wait the page's single-use
 * POST races the refresh-cookie exchange and goes out unauthenticated. With no session at all,
 * send the user to /login and back, carrying GitHub's original query: by now the router has
 * rewritten location.searchStr (see githubLakeCallbackSearch.ts).
 */
export async function requireGitHubLakeCallbackSession(location: { pathname: string; searchStr: string }) {
  await bootstrapSession();
  if (useUser.getState().currentUser) return;

  const redirectTo = buildRedirectTo(location.pathname, getGitHubLakeCallbackBootSearch() ?? location.searchStr);
  throw redirect({ to: '/login', search: redirectTo ? { redirectTo } : undefined });
}
