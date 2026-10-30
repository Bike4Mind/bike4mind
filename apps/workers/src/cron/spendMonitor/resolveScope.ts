import { CreditHolderType, type SpendRollupScopeType } from '@bike4mind/common';
import { Agent, Organization, UserApiKey, userRepository } from '@bike4mind/database';

export type ResolvedScope = {
  label: string;
  payerType: 'User' | 'Organization' | 'unknown';
  payerId: string | null;
  adminPath: string | null;
};

export type ScopeKey = { scopeType: SpendRollupScopeType; scopeId: string };

type UserRef = { id: string; email: string | null; name?: string };
type OrganizationRef = { id: string; name: string };
type ApiKeyRef = {
  id: string;
  name: string;
  userId: string;
  billingOwnerType?: string;
  organizationId?: string;
};
type AgentRef = { id: string; name: string; userId?: string; organizationId?: string };

export type ResolveScopeDeps = {
  findUsersByIds: (ids: string[]) => Promise<UserRef[]>;
  findOrganizationsByIds: (ids: string[]) => Promise<OrganizationRef[]>;
  findApiKeysByIds: (ids: string[]) => Promise<ApiKeyRef[]>;
  findAgentsByIds: (ids: string[]) => Promise<AgentRef[]>;
};

export const scopeMapKey = (scopeType: SpendRollupScopeType, scopeId: string): string => `${scopeType}:${scopeId}`;

const userAdminPath = (userId: string): string => `/admin/users/${userId}`;

const unknownScope = (scopeType: SpendRollupScopeType, scopeId: string): ResolvedScope => ({
  label: `${scopeType} ${scopeId}`,
  payerType: 'unknown',
  payerId: null,
  adminPath: null,
});

const indexById = <T extends { id: string }>(rows: T[]): Map<string, T> => new Map(rows.map(row => [row.id, row]));

const idsOfType = (keys: ScopeKey[], type: SpendRollupScopeType): string[] => [
  ...new Set(keys.filter(key => key.scopeType === type).map(key => key.scopeId)),
];

function resolveOwned(
  label: (ownerLabel: string) => string,
  ownerId: string,
  users: Map<string, UserRef>
): ResolvedScope {
  return {
    label: label(users.get(ownerId)?.email ?? ownerId),
    payerType: 'User',
    payerId: ownerId,
    adminPath: userAdminPath(ownerId),
  };
}

/** One batched lookup per entity type; owners of keys and agents share the single final user lookup. */
export async function resolveScopes(keys: ScopeKey[], deps: ResolveScopeDeps): Promise<Map<string, ResolvedScope>> {
  const [organizations, apiKeys, agents] = await Promise.all([
    deps.findOrganizationsByIds(idsOfType(keys, 'Organization')),
    deps.findApiKeysByIds(idsOfType(keys, 'apiKey')),
    deps.findAgentsByIds(idsOfType(keys, 'Agent')),
  ]);
  const organizationsById = indexById(organizations);
  const apiKeysById = indexById(apiKeys);
  const agentsById = indexById(agents);

  const userIds = new Set(idsOfType(keys, 'User'));
  for (const apiKey of apiKeys) userIds.add(apiKey.userId);
  for (const agent of agents) if (agent.userId) userIds.add(agent.userId);
  const users = indexById(userIds.size > 0 ? await deps.findUsersByIds([...userIds]) : []);

  const resolved = new Map<string, ResolvedScope>();
  for (const { scopeType, scopeId } of keys) {
    resolved.set(scopeMapKey(scopeType, scopeId), resolveOne(scopeType, scopeId));
  }
  return resolved;

  function resolveOne(scopeType: SpendRollupScopeType, scopeId: string): ResolvedScope {
    switch (scopeType) {
      case 'User': {
        const user = users.get(scopeId);
        if (!user) return unknownScope(scopeType, scopeId);
        return { label: user.email ?? scopeId, payerType: 'User', payerId: scopeId, adminPath: userAdminPath(scopeId) };
      }
      case 'Organization': {
        const organization = organizationsById.get(scopeId);
        if (!organization) return unknownScope(scopeType, scopeId);
        return { label: organization.name, payerType: 'Organization', payerId: scopeId, adminPath: null };
      }
      case 'apiKey': {
        const apiKey = apiKeysById.get(scopeId);
        if (!apiKey) return unknownScope(scopeType, scopeId);
        const owner = resolveOwned(ownerLabel => `${apiKey.name} (${ownerLabel})`, apiKey.userId, users);
        if (apiKey.billingOwnerType === CreditHolderType.Organization && apiKey.organizationId) {
          return { ...owner, payerType: 'Organization', payerId: apiKey.organizationId };
        }
        return owner;
      }
      case 'Agent': {
        const agent = agentsById.get(scopeId);
        if (!agent) return unknownScope(scopeType, scopeId);
        if (agent.userId)
          return resolveOwned(ownerLabel => `agent ${agent.name} of ${ownerLabel}`, agent.userId, users);
        // Org-shared agents have no owning user; the org pays.
        if (agent.organizationId) {
          return {
            label: `agent ${agent.name}`,
            payerType: 'Organization',
            payerId: agent.organizationId,
            adminPath: null,
          };
        }
        return unknownScope(scopeType, scopeId);
      }
      default:
        return unknownScope(scopeType, scopeId);
    }
  }
}

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

// A malformed id would make Mongoose throw a CastError for the whole batch; it can never match a real _id.
const validObjectIds = (ids: string[]): string[] => ids.filter(id => OBJECT_ID_PATTERN.test(id));

/** Projections keep secrets (key hashes, password fields) out of every read. */
export function defaultResolveScopeDeps(): ResolveScopeDeps {
  return {
    findUsersByIds: async ids => {
      const users = await userRepository.findByIds(ids);
      return users.map(user => ({ id: String(user._id), email: user.email, name: user.name }));
    },
    findOrganizationsByIds: async ids => {
      const rows = await Organization.find({ _id: { $in: validObjectIds(ids) } })
        .select('name')
        .lean<{ _id: unknown; name: string }[]>();
      return rows.map(row => ({ id: String(row._id), name: row.name }));
    },
    findApiKeysByIds: async ids => {
      const rows = await UserApiKey.find({ _id: { $in: validObjectIds(ids) } })
        .select('name userId billingOwnerType organizationId')
        .lean<{ _id: unknown; name: string; userId: string; billingOwnerType?: string; organizationId?: string }[]>();
      return rows.map(row => ({
        id: String(row._id),
        name: row.name,
        userId: row.userId,
        billingOwnerType: row.billingOwnerType,
        organizationId: row.organizationId,
      }));
    },
    findAgentsByIds: async ids => {
      const rows = await Agent.find({ _id: { $in: validObjectIds(ids) }, deletedAt: null })
        .select('name userId organizationId')
        .lean<{ _id: unknown; name: string; userId?: string; organizationId?: string }[]>();
      return rows.map(row => ({
        id: String(row._id),
        name: row.name,
        userId: row.userId,
        organizationId: row.organizationId,
      }));
    },
  };
}
