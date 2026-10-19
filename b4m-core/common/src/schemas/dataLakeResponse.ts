import * as z from 'zod';
import type { IDataLakeDocument } from '../types/entities/DataLakeTypes';
import type { RetrievabilityLabeledDataLake } from '../constants/dataLakes';
import { passthroughShape } from './responseShape';

// Held to IDataLakeDocument: a new lake field fails the build here until it is listed. This is the
// key boundary only. What a NON-editor may see is decided upstream by redactLakeForActor
// (b4m-core/services/src/dataLakeService/redactLakeForActor.ts, LAKE_FIELD_VISIBILITY), whose
// reader projection is a subset of these keys, so one schema serves both arms.
const DATA_LAKE_RESPONSE_FIELDS = {
  id: true,
  createdAt: true,
  updatedAt: true,
  name: true,
  slug: true,
  description: true,
  systemPrompt: true,
  injectPromptForReaders: true,
  preferredSystemPromptId: true,
  groundingMode: true,
  requiredPassageTokenTarget: true,
  inconsistencyReport: true,
  inconsistencyComputedAt: true,
  lastInconsistencyScanAt: true,
  fileTagPrefix: true,
  datalakeTag: true,
  requiredUserTag: true,
  requiredEntitlement: true,
  createdByUserId: true,
  lastUpdatedByUserId: true,
  organizationId: true,
  isPublic: true,
  auditQueryTextEnabled: true,
  status: true,
  fileCount: true,
  totalSizeBytes: true,
  totalChunkedChars: true,
  embeddingSpendMicroUsd: true,
  lastSyncAt: true,
  lastHealthCheckedAt: true,
  filesDeletedAt: true,
  filesArchivedAt: true,
  purgeClaimId: true,
  purgeStartedAt: true,
  lakeMemoryEnabled: true,
  lakeMemoryExtractionAt: true,
  lakeMemoryCursor: true,
  lakeMemoryPurgedAt: true,
  origin: true,
  pendingConnector: true,
  modelInconsistencyRunAt: true,
} as const satisfies Record<keyof IDataLakeDocument, true>;

/** A lake document as returned by the SPA data-lake routes (editor document or reader projection). */
export const dataLakeResponseSchema = z.object(passthroughShape(DATA_LAKE_RESPONSE_FIELDS));

/** The archived/deleted management views: each lake already redacted for the actor. */
export const dataLakeListResponseSchema = z.object({ data: z.array(dataLakeResponseSchema) });

// Held to RetrievabilityLabeledDataLake (ManageableDataLakeConfig plus the opt-in `retrievable`),
// the actor-aware projection listDataLakes/listAllDataLakes build. Not the public v1 shape, which
// lives in ./dataLakePublic.ts and is deliberately narrower.
const DATA_LAKE_CONFIG_RESPONSE_FIELDS = {
  id: true,
  slug: true,
  name: true,
  requiredUserTag: true,
  requiredEntitlement: true,
  fileTagPrefix: true,
  datalakeTag: true,
  organizationId: true,
  description: true,
  isPublic: true,
  lakeMemoryEnabled: true,
  injectPromptForReaders: true,
  canManage: true,
  status: true,
  origin: true,
  systemPrompt: true,
  requiredPassageTokenTarget: true,
  isOwn: true,
  isCreator: true,
  canPreauthorize: true,
  ownerDisplayName: true,
  ownerUserId: true,
  ownerUsername: true,
  preferredSystemPromptId: true,
  pendingProposalCount: true,
  groundingMode: true,
  pendingConnector: true,
  hasGitHubConnection: true,
  embeddingSpendMicroUsd: true,
  canRebuild: true,
  canManageSettings: true,
  canManageMemory: true,
  retrievable: true,
} as const satisfies Record<keyof RetrievabilityLabeledDataLake, true>;

/** GET /api/data-lakes: the actor-aware list projection, optionally retrievability-labeled. */
export const dataLakeConfigListResponseSchema = z.object({
  data: z.array(z.object(passthroughShape(DATA_LAKE_CONFIG_RESPONSE_FIELDS))),
});
