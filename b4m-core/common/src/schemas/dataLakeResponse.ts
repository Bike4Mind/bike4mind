import * as z from 'zod';
import type { IDataLakeBatchDocument, IDataLakeDocument } from '../types/entities/DataLakeTypes';
import type { ILakeFindingListItem } from '../types/entities/DataLakeFindingTypes';
import type { IDataLakeProposalDocument } from '../types/entities/DataLakeProposalTypes';
import type {
  IDataLakeResearchConfigDocument,
  IDataLakeResearchRunDocument,
} from '../types/entities/DataLakeResearchTypes';
import type { IDataLakeOwnershipOfferDocument } from '../types/entities/DataLakeOwnershipOfferTypes';
import type { RetrievabilityLabeledDataLake } from '../constants/dataLakes';
import { fabFileResponseSchema } from './fabFileResponse';
import { passthroughField, passthroughShape } from './responseShape';

// Held to IDataLakeDocument: a new lake field fails the build here until it is listed. This is the
// key boundary only - it strips keys it does not list, it never withholds one. What a NON-editor may
// see is decided upstream by redactLakeForActor (b4m-core/services/src/dataLakeService/
// redactLakeForActor.ts), whose reader allow-list (READER_LAKE_FIELDS) is a subset of these keys, so
// one schema serves both arms. Skipping redactLakeForActor on a read path would still serve
// systemPrompt to a reader: this schema declares it.
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

// Held to ILakeFindingListItem: the list route adds `supersededFabFileIds`, the ruling routes return
// the bare finding, so it is optional in effect (an absent passthrough key stays absent).
const LAKE_FINDING_RESPONSE_FIELDS = {
  id: true,
  createdAt: true,
  updatedAt: true,
  lakeId: true,
  kind: true,
  subject: true,
  detector: true,
  sources: true,
  documentCount: true,
  status: true,
  firstSeenAt: true,
  lastSeenAt: true,
  assigneeUserId: true,
  resolution: true,
  resolvedByUserId: true,
  resolvedAt: true,
  supersededFabFileIds: true,
} as const satisfies Record<keyof ILakeFindingListItem, true>;

/** One detected corpus problem as the findings routes return it. */
export const lakeFindingResponseSchema = z.object(passthroughShape(LAKE_FINDING_RESPONSE_FIELDS));

/** GET /api/data-lakes/:id/findings: one page of the queue. */
export const lakeFindingListResponseSchema = z.object({
  data: z.array(lakeFindingResponseSchema),
  hasMore: z.boolean(),
});

/** POST /api/data-lakes/:id/findings/:findingId, `assign` action. */
export const lakeFindingAssignResponseSchema = z.object({ data: lakeFindingResponseSchema });

/** POST /api/data-lakes/:id/findings/:findingId, `resolve` / `dismiss` actions. */
export const lakeFindingRulingResponseSchema = z.object({
  data: lakeFindingResponseSchema,
  beliefRecorded: z.boolean(),
  beliefSkipReason: z.string().optional(),
});

// Held to IDataLakeProposalDocument minus `textHash`, the server-side dedupe digest no client reads.
const LAKE_PROPOSAL_RESPONSE_FIELDS = {
  id: true,
  createdAt: true,
  updatedAt: true,
  dataLakeId: true,
  status: true,
  sourceUrl: true,
  canonicalSourceKey: true,
  title: true,
  excerpt: true,
  proposedTags: true,
  confidence: true,
  rationale: true,
  provenance: true,
  priorDisposition: true,
  reviewedByUserId: true,
  reviewedAt: true,
  declineReason: true,
  admittedFabFileId: true,
} as const satisfies Record<Exclude<keyof IDataLakeProposalDocument, 'textHash'>, true>;

/** One acquisition proposal as the review-queue routes return it. */
export const lakeProposalResponseSchema = z.object(passthroughShape(LAKE_PROPOSAL_RESPONSE_FIELDS));

/** GET /api/data-lakes/:id/proposals. */
export const lakeProposalListResponseSchema = z.object({ data: z.array(lakeProposalResponseSchema) });

/** POST /api/data-lakes/:id/proposals/:proposalId, `decline` and `restore` decisions. */
export const lakeProposalReviewResponseSchema = z.object({ data: lakeProposalResponseSchema });

/** POST /api/data-lakes/:id/proposals/:proposalId, `approve` decision: the proposal plus the admitted file. */
export const lakeProposalApproveResponseSchema = z.object({
  data: lakeProposalResponseSchema,
  fabFile: z.object({ id: z.string(), fileName: z.string() }),
});

// Held to IDataLakeResearchConfigDocument.
const RESEARCH_CONFIG_RESPONSE_FIELDS = {
  id: true,
  createdAt: true,
  updatedAt: true,
  dataLakeId: true,
  name: true,
  trigger: true,
  cadence: true,
  reviewBacklogLimit: true,
  nextRunAt: true,
  scheduleAnchorAt: true,
  lastScheduledOutcome: true,
  createdByUserId: true,
  lastUpdatedByUserId: true,
  lastRunAt: true,
  query: true,
  model: true,
  maxResults: true,
  maxProposals: true,
  recencyDays: true,
  allowedDomains: true,
  blockedDomains: true,
  minRelevance: true,
  costCeilingMicroUsd: true,
  proposedTags: true,
} as const satisfies Record<keyof IDataLakeResearchConfigDocument, true>;

/** One saved research configuration. */
export const researchConfigResponseSchema = z.object(passthroughShape(RESEARCH_CONFIG_RESPONSE_FIELDS));

/** GET /api/data-lakes/:id/research/configs: the configs plus the lake's live pending-proposal count. */
export const researchConfigListResponseSchema = z.object({
  data: z.array(researchConfigResponseSchema),
  pendingProposals: z.number(),
});

/** POST and PUT on the research config routes. */
export const researchConfigEnvelopeResponseSchema = z.object({ data: researchConfigResponseSchema });

// Held to IDataLakeResearchRunDocument.
const RESEARCH_RUN_RESPONSE_FIELDS = {
  id: true,
  createdAt: true,
  updatedAt: true,
  dataLakeId: true,
  configId: true,
  levers: true,
  trigger: true,
  startedByUserId: true,
  status: true,
  startedAt: true,
  completedAt: true,
  stopReason: true,
  spentMicroUsd: true,
  totals: true,
  judgeModel: true,
  error: true,
} as const satisfies Record<keyof IDataLakeResearchRunDocument, true>;

/** One research run. */
export const researchRunResponseSchema = z.object(passthroughShape(RESEARCH_RUN_RESPONSE_FIELDS));

/** GET /api/data-lakes/:id/research/runs. */
export const researchRunListResponseSchema = z.object({ data: z.array(researchRunResponseSchema) });

/** POST /api/data-lakes/:id/research/runs (the queued run). */
export const researchRunEnvelopeResponseSchema = z.object({ data: researchRunResponseSchema });

// Held to IDataLakeOwnershipOfferDocument minus the fields that only the server acts on: the audit
// principal (a key or session id), the owner snapshot and the authority rung the offer was made
// under. No client reads them.
const LAKE_OWNERSHIP_OFFER_RESPONSE_FIELDS = {
  id: true,
  createdAt: true,
  updatedAt: true,
  dataLakeId: true,
  offeredByUserId: true,
  recipientUserId: true,
  status: true,
  expiresAt: true,
  organizationId: true,
  resolvedAt: true,
} as const satisfies Record<
  Exclude<keyof IDataLakeOwnershipOfferDocument, 'auditPrincipal' | 'priorOwnerUserIds' | 'offeredVia'>,
  true
>;

/** POST (open) and DELETE (cancel) on /api/data-lakes/:id/transfer-ownership. */
export const lakeOwnershipOfferResponseSchema = z.object({
  offer: z.object(passthroughShape(LAKE_OWNERSHIP_OFFER_RESPONSE_FIELDS)),
});

// Held to IDataLakeBatchDocument minus the server-only fields: the billing attribution (org and API
// key ids), the uploader's resolved manage rung and the upload-history write marker. No client reads them.
const DATA_LAKE_BATCH_RESPONSE_FIELDS = {
  id: true,
  createdAt: true,
  updatedAt: true,
  dataLakeId: true,
  userId: true,
  status: true,
  conflictResolution: true,
  totalFiles: true,
  uploadedFiles: true,
  chunkedFiles: true,
  vectorizedFiles: true,
  failedFiles: true,
  failedFileNames: true,
  processingFailedFiles: true,
  skippedFiles: true,
  deferredFiles: true,
  skippedDriveFileIds: true,
  totalSizeBytes: true,
  uploadedSizeBytes: true,
  embeddingSpendMicroUsd: true,
  files: true,
  appliedTags: true,
  startedAt: true,
  completedAt: true,
  completionReason: true,
  wantsTaxonomy: true,
  taxonomyStatus: true,
  taxonomyStartedAt: true,
  taxonomySuggestions: true,
  taxonomyError: true,
} as const satisfies Record<
  Exclude<keyof IDataLakeBatchDocument, 'taxonomyBilling' | 'uploaderManageRung' | 'uploadHistoryRecordedAt'>,
  true
>;

/** An upload batch, returned bare by the batch routes (create, read, re-analyze taxonomy). */
export const dataLakeBatchResponseSchema = z.object(passthroughShape(DATA_LAKE_BATCH_RESPONSE_FIELDS));

// The list queries project out `files` and the per-file taxonomy assignments, so those keys are simply
// absent; the key boundary is otherwise the same as for one batch. The summary type is an Omit<>, which
// the no-raw-entity-response lint rule reads as an explicit projection, so nothing but this schema
// keeps the server-only fields off the list.
/** GET /api/data-lakes/batches: the caller's batches that still need attention. */
export const dataLakeBatchListResponseSchema = z.object({ data: z.array(dataLakeBatchResponseSchema) });

/** GET /api/data-lakes/:id/articles: one page of the lake's own files. */
export const dataLakeArticleListResponseSchema = z.object({
  data: z.array(fabFileResponseSchema.extend({ membershipArm: passthroughField })),
  total: z.number(),
  hasMore: z.boolean(),
});
