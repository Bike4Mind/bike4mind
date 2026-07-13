/*
 * TO ADD NEW MIGRATIONS:
 *
 * 1. Run `pnpm migrate generate "add fancy new field". It'll generate a file.
 * 2. Import the file below
 * 3. Reference the imported variable in the AvailableMigrations array
 */

// 2. Import the file here:
import DemoToPaid from './2024052201905_demo_to_paid';
import CreateAndPopulateQuests from './20240524172716_create-and-populate-quests';
import CreateDefaultSession from './20240723201224_create-sessions-for-users-with-no-sessions';
import MigrateCountersData from './20240909152817_migrate-counters-to-useractivitycounter-collection';
import RenameCounterNames from './20241211100000_rename_counter_names';
import RemoveChunkAndVectorFiles from './20250107123500_remove_chunk_and_vector_files';
import AddSessionAndFileIdsToProjects from './20250108000000_add_session_and_file_ids_to_projects';
import AddSystemPromptsToProjects from './20250108123000_add_system_prompts_to_projects';
import ChangeIdsToStringsInQuests from './20250210183952_change-ids-to-strings-in-quests';
import AddClonedSourceIdAndForkedSourceIdToSessionModels from './20250123223300_add-clonedsourceid-and-forkedsourceid-to-sessionmodels';
import AddPhotoUrlToUsers from './20250128133728_add-photourl-to-collection';
import RemoveUniqueNameFromProjects from './20250221174326_remove-unique-name-from-projects';
import AddLastUsedModelToSessionModels from './20250313152624_add-lastusedmodel-to-sessionmodels';
import AddUserDetailsToOrg from './20250321142457_add-user-details-to-org';
import FixExistingOrganizationData from './20250325153205_fix-existing-organization-data';
import AddApiKeyExpiration from './20250422132525_add-api-key-expiration';
import EnsureMementoIndexes from './20250510000100_ensure-memento-indexes';
import CreateArtifactCollections from './20250202100000_create-artifact-collections';
import FixFilesize from './20250630185100_fix_filesize';
import AddFilenameLowercase from './20250704005300-add-filename-lowercase';
import AddSharePermissionsToExistingUsers from './20250715000000_add-share-permissions-to-existing-users';
import UpdateRegistrationInviteEmailIndex from './20250730000000-registration-invite-sparse-email-index';
import CreateRapidReplyCollections from './20250906000000-create-rapid-reply-collections';
import MigrateOldCreditsTxnHistory from './20250917124558_migrate-old-credits-txn-history';
import DropRedundantIndexes from './20251002113208_drop-redundant-indexes';
import DropRedundantIndexes2 from './20251006101839_drop-redundant-indexes';
import DeleteDeprecatedChunks from './20251008130737_delete-deprecated-chunks';
import DropConflictingCounterlogIndex from './20251010091008_drop-conflicting-counterlog-index';
import EnhanceQuestMasterPlans from './20251014000000_enhance-questmaster-plans';
import DropUnusedProjectUniqueNameIndex from './20251022125702_drop-unused-project-unique-name-index';
import AddEmailVerificationIndexes from './20251023120000_add-email-verification-indexes';
import AddTokenUsedFlags from './20251023130000_add-token-used-flags';
import PermanentlyDeleteExistingMementos from './20251024141313_permanently-delete-existing-mementos';
import FixRapidReplyQuestIdIndex from './20251205000000-fix-rapid-reply-questid-index';
import ConvertQuestImagesToFilenames from './20251106201805_convert-quest-images-to-filenames';
import ConvertAdminLogoValuesToFilepath from './20251107195534_convert-admin-logo-values-to-filepath';
import FixSessionSlackmetadataIndex from './20251126202452_fix-session-slackmetadata-index';
import DropSlackTeamIdUniqueIndex from './20251210000000_drop-slackteamid-unique-index';
import InitializeSystemSecrets from './20260116140000_initialize-system-secrets';
import MigrateUserSubscriptionToSubscription from './20260120142227_migrate-usersubscription-to-subscription';
import SetAgentsIsPublicFalse from './20260210000000_set-agents-ispublic-false';
import BackfillSubscriptionSource from './20260518120000_backfill-subscription-source';
import DataLakeOrgScopedSlugIndex from './20260529000000_datalake-org-scoped-slug-index';
import BackfillCreditTransactionSource from './20260529120000_backfill-credit-transaction-source';
import BriefcaseIndexesAndSeed from './20260602000000_briefcase-indexes-and-seed';
import UserEmailPartialUniqueIndex from './20260619000000_user-email-partial-unique-index';
import AddAuthProvidersStrategyIdIndex from './20260620000000_add-authproviders-strategy-id-index';
import LowercaseAgentTriggerWords from './20260626000000_lowercase-agent-trigger-words';
import BackfillPolicyAcceptanceGrandfather from './20260702010000_backfill-policy-acceptance-grandfather';
import HashMfaBackupCodes from './20260702000000_hash-mfa-backup-codes';
import BackfillCreditLots from './20260707120000_backfill-credit-lots';
import AddHasUsablePasswordToUsers from './20260709120000_add-hasusablepassword-to-users';
import BaseEntitlementOnDefaultModels from './20260709130000_base-entitlement-on-default-models';
import NullShellAccountPasswords from './20260710120000_null-shell-account-passwords';
import BaseEntitlementCoverDriftedSeedConfigs from './20260710160000_base-entitlement-cover-drifted-seed-configs';

export interface MigrationFile {
  id: number;
  name: string;
  up: () => Promise<void>;
  down: () => Promise<void>;
}

// 3. Reference the imported variable here:
export const AvailableMigrations: MigrationFile[] = [
  DemoToPaid,
  CreateAndPopulateQuests,
  CreateDefaultSession,
  MigrateCountersData,
  RenameCounterNames,
  RemoveChunkAndVectorFiles,
  AddSessionAndFileIdsToProjects,
  AddSystemPromptsToProjects,
  ChangeIdsToStringsInQuests,
  AddClonedSourceIdAndForkedSourceIdToSessionModels,
  AddPhotoUrlToUsers,
  RemoveUniqueNameFromProjects,
  AddLastUsedModelToSessionModels,
  AddUserDetailsToOrg,
  FixExistingOrganizationData,
  AddApiKeyExpiration,
  EnsureMementoIndexes,
  CreateArtifactCollections,
  FixFilesize,
  AddFilenameLowercase,
  AddSharePermissionsToExistingUsers,
  UpdateRegistrationInviteEmailIndex,
  CreateRapidReplyCollections,
  MigrateOldCreditsTxnHistory,
  DropRedundantIndexes,
  DropRedundantIndexes2,
  DeleteDeprecatedChunks,
  DropConflictingCounterlogIndex,
  EnhanceQuestMasterPlans,
  DropUnusedProjectUniqueNameIndex,
  AddEmailVerificationIndexes,
  AddTokenUsedFlags,
  PermanentlyDeleteExistingMementos,
  FixRapidReplyQuestIdIndex,
  ConvertQuestImagesToFilenames,
  ConvertAdminLogoValuesToFilepath,
  FixSessionSlackmetadataIndex,
  DropSlackTeamIdUniqueIndex,
  InitializeSystemSecrets,
  MigrateUserSubscriptionToSubscription,
  SetAgentsIsPublicFalse,
  BackfillSubscriptionSource,
  DataLakeOrgScopedSlugIndex,
  BackfillCreditTransactionSource,
  BriefcaseIndexesAndSeed,
  UserEmailPartialUniqueIndex,
  AddAuthProvidersStrategyIdIndex,
  LowercaseAgentTriggerWords,
  BackfillPolicyAcceptanceGrandfather,
  HashMfaBackupCodes,
  BackfillCreditLots,
  AddHasUsablePasswordToUsers,
  BaseEntitlementOnDefaultModels,
  NullShellAccountPasswords,
  BaseEntitlementCoverDriftedSeedConfigs,
];
