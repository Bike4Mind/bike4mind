import { getSlackDb } from '../di/registry';

type Account = { userId: string; metadata?: { githubLogin?: string } };
type AccountFilter = { userIds: string[]; logins?: string[] } | { logins: string[]; userIds?: string[] };

export async function findVerifiedGitHubAccounts(filter: AccountFilter): Promise<Account[]> {
  const { McpServer } = getSlackDb();
  return (
    McpServer as {
      find(query: Record<string, unknown>): { select(fields: string): Promise<Account[]> };
    }
  )
    .find({
      name: 'github',
      enabled: true,
      ...(filter.userIds ? { userId: { $in: filter.userIds } } : {}),
      'metadata.githubLogin': filter.logins
        ? {
            $in: filter.logins.map(name => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')),
          }
        : { $type: 'string', $ne: '' },
    })
    .select('userId metadata.githubLogin');
}
