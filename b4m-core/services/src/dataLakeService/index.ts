export {
  BaseSearchIndex,
  OpenSearchClient,
  type SearchDocument,
  buildSearchIndexSettings,
  buildSearchIndexSettingsForModel,
} from '@bike4mind/fab-pipeline';
export * from './utils';
export * from './ports';
export * from './assertLakeAccess';
export * from './authorizeLakeWrite';
// canManageLake + ManageActor are already surfaced via authorizeLakeWrite's re-export; export the
// rest of the pure decision core (owner resolution) by name to avoid a duplicate-export clash.
export { isEffectiveOwner, isLakeCreator, resolveEffectiveOwnerIds, type LakeGrant } from './manageRule';
export * from './authorizeLakeManage';
export * from './transferLakeOwnership';
export * from './authorizeBatchAccess';
export * from './fallbackLakeTags';
export * from './lakeMembershipScope';
export * from './tagPrefixCollision';
export * from './createDataLake';
export * from './updateDataLake';
export * from './setLakeVisibility';
export * from './listDataLakes';
export * from './redactLakeForActor';
export * from './browsePublicDataLakes';
export * from './archiveDataLake';
export * from './unarchiveDataLake';
export * from './restoreDeletedDataLake';
export * from './deleteDataLake';
export * from './lakeMembership';
export * from './prefixArmMembership';
export * from './chunkPolicyConflict';
export * from './removeFileFromDataLake';
export * from './cleanupDeletedDataLake';
export * from './recomputeLakeStats';
export * from './reconcileStuckBatches';
export * from './reconcileStuckTaxonomy';
export * from './applyTaxonomySuggestions';
export * from './dismissTaxonomySuggestion';
export * from './getDynamicDataLakeTags';
export * from './embeddingMismatch';
export * from './getDataLakePrompts';
export * from './semanticDataLakeSearch';
export * from './boundedTopK';
export * from './resolveSearchBudgets';
export * from './resolveSpendLevers';
export * from './enforceEmbeddingSpendGate';
export * from './resolveLakeSpendAddressees';
export * from './spendNotificationKeys';
export * from './renderSpendNotificationEmail';
export * from './sendDataLakeSpendNotification';
export * from './resolveLakeAuditRetention';
export * from './openSearchVectorSearch';
export * from './openSearchChunkAdapter';
export * from './openSearchRetrievalIndex';
