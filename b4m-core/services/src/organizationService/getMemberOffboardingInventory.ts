import { IGroupRepository, IOrganizationRepository, IUserApiKeyRepository, IUserDocument } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import {
  loadOffboardableOrganization,
  orgAgentFilter,
  orgBilledKeyFilter,
  orgProjectFilter,
  orgSessionFilter,
  orgStampedFilter,
  type OffboardingScope,
} from './offboardingScope';

export const OFFBOARDING_SAMPLE_LIMIT = 25;

const parametersSchema = z.object({ id: z.string().min(1), userId: z.string().min(1) });

type Named = { id: string; name?: string; title?: string; fileName?: string };
type Filter = Record<string, unknown>;

/** `options` is the db-core BaseRepository passthrough: `limit`/`sort`, remaining keys project. */
interface Listable<T extends Named = Named> {
  find: (filter: Filter, options?: Record<string, unknown>) => Promise<T[]>;
}

interface Countable<T extends Named = Named> extends Listable<T> {
  count: (filter: Filter) => Promise<number>;
}

export interface MemberOffboardingInventoryAdapters {
  db: {
    organizations: Pick<IOrganizationRepository, 'findById'>;
    groups: Pick<IGroupRepository, 'findByOrganization'>;
    fabFiles: Countable;
    artifacts: Countable;
    projects: Countable;
    sessions: Countable;
    agents: Countable;
    userApiKeys: Pick<IUserApiKeyRepository, 'count'>;
  };
}

export interface OffboardingInventoryEntry {
  count: number;
  sample: { id: string; name: string }[];
}

export interface MemberOffboardingInventory {
  files: OffboardingInventoryEntry;
  artifacts: OffboardingInventoryEntry;
  projects: OffboardingInventoryEntry;
  notebooks: OffboardingInventoryEntry;
  agents: OffboardingInventoryEntry;
  orgBilledApiKeys: { count: number };
}

const EMPTY: OffboardingInventoryEntry = { count: 0, sample: [] };

const toSample = (docs: Named[]) =>
  docs
    .slice(0, OFFBOARDING_SAMPLE_LIMIT)
    .map(doc => ({ id: String(doc.id), name: doc.name ?? doc.title ?? doc.fileName ?? '' }));

const SAMPLE_QUERY = { limit: OFFBOARDING_SAMPLE_LIMIT, sort: { updatedAt: -1 } };

async function summarize(repo: Countable, filter: Filter | null): Promise<OffboardingInventoryEntry> {
  if (!filter) return EMPTY;
  const [docs, count] = await Promise.all([repo.find(filter, SAMPLE_QUERY), repo.count(filter)]);
  return { count, sample: toSample(docs) };
}

/** What a departing member owns in the org's context, for the admin deciding where it should go. */
export async function getMemberOffboardingInventory(
  actor: IUserDocument,
  parameters: { id: string; userId: string },
  adapters: MemberOffboardingInventoryAdapters
): Promise<MemberOffboardingInventory> {
  const { id: organizationId, userId: memberId } = secureParameters(parameters, parametersSchema);
  const { db } = adapters;
  await loadOffboardableOrganization(actor, organizationId, memberId, db.organizations);

  const orgGroupIds = (await db.groups.findByOrganization(organizationId)).map(group => String(group.id));
  const scope: OffboardingScope = { organizationId, memberId, orgGroupIds };

  const [files, artifacts, projects, notebooks, agents, orgBilledKeyCount] = await Promise.all([
    summarize(db.fabFiles, orgStampedFilter(scope)),
    summarize(db.artifacts, orgStampedFilter(scope)),
    summarize(db.projects, orgProjectFilter(scope)),
    summarize(db.sessions, orgSessionFilter(scope)),
    summarize(db.agents, orgAgentFilter(scope)),
    db.userApiKeys.count(orgBilledKeyFilter(scope)),
  ]);

  return {
    files,
    artifacts,
    projects,
    notebooks,
    agents,
    orgBilledApiKeys: { count: orgBilledKeyCount },
  };
}
