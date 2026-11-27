import type { EndpointContract } from '../types';
import { chatContract } from './chat.contract';
import { startAgentExecutionContract, getAgentExecutionContract } from './agentExecutions.contract';
import { sessionUpdateContract } from './sessionUpdate.contract';
import { sessionGetContract } from './sessionGet.contract';
import { sessionDeleteContract } from './sessionDelete.contract';
import { sessionCloneContract } from './sessionClone.contract';
import { executeToolContract } from './tools.contract';
import { searchWebContract, fetchWebPageContract, getCurrentWeatherContract } from './webTools.contract';
import { createCompletionContract } from './completions.contract';
import {
  createCompletionRunContract,
  getCompletionRunEvaluationContract,
  getCompletionRunUsageContract,
  raiseCompletionRunBudgetContract,
} from './completionRuns.contract';
import { synthesizeSpeechContract } from './tts.contract';
import { generateMusicContract } from './music.contract';
import { generateSoundEffectContract } from './soundEffects.contract';
import { getMeContract } from './me.contract';
import { getClientConfigContract, getPublicClientConfigContract } from './clientConfig.contract';
import { approvePendingActionContract, denyPendingActionContract } from './pendingActions.contract';
import {
  composeBriefContract,
  composeFollowUpBriefContract,
  listBriefsContract,
  getBriefContract,
  getBriefScheduleContract,
  putBriefScheduleContract,
  getBusyBlocksContract,
  putBusyBlocksContract,
  replyToBriefDecisionContract,
  editBriefDecisionContract,
  resolveBriefDecisionContract,
  getPendingDecisionCountContract,
} from './briefs.contract';
import { createDelegationContract, getDelegationContract } from './delegations.contract';
import {
  getObligationContract,
  handOffObligationContract,
  listObligationsContract,
  updateObligationContract,
} from './obligations.contract';
import { registerPushTokenContract, unregisterPushTokenContract } from './pushTokens.contract';
import { listHandoffDevicesContract, sendSessionHandoffContract } from './sessionHandoff.contract';
import {
  listAssistantInstructionsContract,
  createAssistantInstructionContract,
  deleteAssistantInstructionContract,
} from './assistantInstructions.contract';
import { getInterruptionFeedbackContract, putInterruptionFeedbackContract } from './interruptionFeedback.contract';
import { mintPersonaContract, deletePersonaContract } from './personas.contract';
import { getCreditBalanceContract } from './credits.contract';
import { listModelsContract } from './models.contract';
import { generateImageContract } from './imageGeneration.contract';
import { editImageContract } from './imageEdit.contract';
import {
  cancelImageJobContract,
  createImageJobContract,
  getImageJobContract,
  listImageJobsContract,
} from './imageJob.contract';
import {
  createFileUploadContract,
  getFileContract,
  listFilesContract,
  updateFileContract,
  deleteFileContract,
  chunkFileContract,
  searchFilesContract,
  getFilesByIdsContract,
  getFileLineageContract,
  bulkDeleteFilesContract,
} from './files.contract';
import { createEmbeddingsContract, listEmbeddingModelsContract } from './embeddings.contract';
import { postSlackMessageContract } from './slackMessages.contract';
import {
  cancelFunctionCallContract,
  getFunctionCallContract,
  getFunctionContract,
  invokeFunctionContract,
  listFunctionsContract,
} from './functions.contract';
import {
  createFunctionContract,
  deleteFunctionContract,
  findFunctionRecipientContract,
  getAuthoredFunctionContract,
  getFunctionCallSummaryContract,
  getFunctionShareContract,
  listAuthoredFunctionsContract,
  pinFunctionDataContract,
  promoteFunctionContract,
  runFunctionTestsContract,
  saveFunctionCodeContract,
  setFunctionExamplesContract,
  setFunctionSourcesContract,
  shareFunctionContract,
  unpinFunctionDataContract,
  unshareFunctionContract,
  updateFunctionContract,
} from './functionsAuthoring.contract';
import { createTextRefinementContract } from './textRefinement.contract';
import { createDecisionContract, listDecisionModelsContract } from './decisions.contract';
import { getQuestContract, listQuestFilesContract } from './quest.contract';
import {
  listArtifactsContract,
  createArtifactContract,
  getArtifactContract,
  updateArtifactContract,
  deleteArtifactContract,
  listArtifactVersionsContract,
  getArtifactVersionContract,
  createArtifactVersionContract,
  searchArtifactsContract,
  listArtifactTypesContract,
  publishArtifactContract,
  republishArtifactContract,
  unpublishArtifactContract,
} from './artifacts.contract';
import { createTranscriptionUploadContract, createTranscriptionContract } from './transcription.contract';
import { createSessionContract } from './sessionCreate.contract';
import { listSessionsContract } from './sessionList.contract';
import { getSessionByIdContract } from './sessionGetById.contract';
import { listSessionQuestsContract } from './sessionQuests.contract';
import { listSessionFilesContract } from './sessionFiles.contract';
import { searchSessionsContract } from './sessionSemanticSearch.contract';
import {
  getSessionMessageContract,
  updateSessionMessageContract,
  deleteSessionMessageContract,
} from './sessionMessages.contract';
import { listCreditTransactionsContract } from './creditTransactions.contract';
import { getWhatsNewMediaContract, listWhatsNewContract } from './whatsNew.contract';
import {
  listDataLakesContract,
  getDataLakeContract,
  getDataLakeFileContract,
  addDataLakeFileContract,
  removeDataLakeFileContract,
  searchDataLakeContract,
} from './dataLakes.contract';
import {
  listDataLakeResearchConfigsContract,
  createDataLakeResearchConfigContract,
  getDataLakeResearchConfigContract,
  updateDataLakeResearchConfigContract,
  deleteDataLakeResearchConfigContract,
  startDataLakeResearchRunContract,
  listDataLakeResearchRunsContract,
  getDataLakeResearchRunContract,
  listDataLakeProposalsContract,
  decideDataLakeProposalContract,
  getDataLakeConfigHistoryContract,
  undoDataLakeConfigChangeContract,
} from './dataLakeResearch.contract';
import { listImageModelsContract } from './imageModels.contract';
import {
  cancelVideoGenerationContract,
  createVideoGenerationContract,
  getVideoGenerationContract,
  listVideoGenerationsContract,
  listVideoModelsContract,
} from './videoGeneration.contract';
import {
  cancelMusicGenerationContract,
  createMusicGenerationContract,
  getMusicGenerationContract,
  listMusicGenerationsContract,
  listMusicModelsContract,
} from './musicGeneration.contract';
import {
  cancelSceneCompositionContract,
  createSceneCompositionContract,
  getSceneCompositionContract,
  listSceneCompositionsContract,
} from './sceneComposition.contract';
import { listVoicesContract, createVoiceSessionContract, endVoiceSessionContract } from './voice.contract';
import {
  listProjectsContract,
  getProjectContract,
  createProjectContract,
  updateProjectContract,
  deleteProjectContract,
} from './projects.contract';
import {
  listProjectFilesContract,
  addProjectFilesContract,
  removeProjectFileContract,
  listProjectSessionsContract,
  addProjectSessionsContract,
  removeProjectSessionContract,
} from './projectContent.contract';
import {
  removeProjectMemberContract,
  listProjectInvitesContract,
  createProjectInviteContract,
  addProjectSystemPromptsContract,
  updateProjectSystemPromptContract,
  removeProjectSystemPromptContract,
} from './projectSharing.contract';
import {
  listAgentsContract,
  getAgentContract,
  createAgentContract,
  updateAgentContract,
  deleteAgentContract,
  generateAgentAvatarContract,
  generateAgentDescriptionContract,
  generateAgentSystemPromptContract,
  enhanceAgentFieldContract,
  transferAgentCreditsContract,
  createAgentFromContextContract,
} from './agents.contract';
import {
  getClaudeBundleZipContract,
  getClaudeMarketplaceContract,
  getClaudePluginZipContract,
} from './skillMarket.contract';
import {
  listSkillMarketListingsContract,
  getSkillMarketListingContract,
  publishSkillMarketListingContract,
  listMySkillMarketListingsContract,
  withdrawSkillMarketListingContract,
  submitSkillMarketListingVersionContract,
  importSkillMarketListingContract,
  rescanSkillMarketVersionContract,
} from './skillMarketWrite.contract';
import { createSkillContract, updateSkillContract, listMySkillsContract, getSkillContract } from './skills.contract';
import { listSkillMarketReviewQueueContract, reviewSkillMarketVersionContract } from './skillMarketReview.contract';

/**
 * Every public endpoint, as a contract. The OpenAPI generator registers each of
 * these (openapi/registerContract.ts); adding a contract here is all it takes for
 * it to appear in the spec + docs. This is the single source of truth for the
 * published API surface - the entire `/v1` docs are generated from this array.
 */
export const CONTRACTS: readonly EndpointContract[] = [
  chatContract,
  startAgentExecutionContract,
  getAgentExecutionContract,
  sessionGetContract,
  sessionUpdateContract,
  sessionDeleteContract,
  sessionCloneContract,
  executeToolContract,
  searchWebContract,
  fetchWebPageContract,
  getCurrentWeatherContract,
  createCompletionContract,
  createCompletionRunContract,
  getCompletionRunEvaluationContract,
  getCompletionRunUsageContract,
  raiseCompletionRunBudgetContract,
  synthesizeSpeechContract,
  generateMusicContract,
  generateSoundEffectContract,
  getMeContract,
  getClientConfigContract,
  getPublicClientConfigContract,
  approvePendingActionContract,
  denyPendingActionContract,
  composeBriefContract,
  composeFollowUpBriefContract,
  listBriefsContract,
  getBriefContract,
  getBriefScheduleContract,
  putBriefScheduleContract,
  getBusyBlocksContract,
  putBusyBlocksContract,
  listAssistantInstructionsContract,
  createAssistantInstructionContract,
  deleteAssistantInstructionContract,
  getInterruptionFeedbackContract,
  putInterruptionFeedbackContract,
  replyToBriefDecisionContract,
  editBriefDecisionContract,
  resolveBriefDecisionContract,
  getPendingDecisionCountContract,
  createDelegationContract,
  getDelegationContract,
  handOffObligationContract,
  listObligationsContract,
  getObligationContract,
  updateObligationContract,
  registerPushTokenContract,
  unregisterPushTokenContract,
  listHandoffDevicesContract,
  sendSessionHandoffContract,
  getCreditBalanceContract,
  listModelsContract,
  generateImageContract,
  editImageContract,
  createImageJobContract,
  getImageJobContract,
  listImageJobsContract,
  cancelImageJobContract,
  createFileUploadContract,
  getFileContract,
  listFilesContract,
  updateFileContract,
  deleteFileContract,
  chunkFileContract,
  searchFilesContract,
  getFilesByIdsContract,
  getFileLineageContract,
  bulkDeleteFilesContract,
  createEmbeddingsContract,
  listEmbeddingModelsContract,
  createTextRefinementContract,
  createDecisionContract,
  listDecisionModelsContract,
  getQuestContract,
  listQuestFilesContract,
  createSessionContract,
  listSessionsContract,
  getSessionByIdContract,
  listSessionQuestsContract,
  listSessionFilesContract,
  searchSessionsContract,
  getSessionMessageContract,
  updateSessionMessageContract,
  deleteSessionMessageContract,
  listCreditTransactionsContract,
  listDataLakesContract,
  getDataLakeContract,
  getDataLakeFileContract,
  addDataLakeFileContract,
  removeDataLakeFileContract,
  searchDataLakeContract,
  listDataLakeResearchConfigsContract,
  createDataLakeResearchConfigContract,
  getDataLakeResearchConfigContract,
  updateDataLakeResearchConfigContract,
  deleteDataLakeResearchConfigContract,
  startDataLakeResearchRunContract,
  listDataLakeResearchRunsContract,
  getDataLakeResearchRunContract,
  listDataLakeProposalsContract,
  decideDataLakeProposalContract,
  getDataLakeConfigHistoryContract,
  undoDataLakeConfigChangeContract,
  listImageModelsContract,
  cancelVideoGenerationContract,
  createVideoGenerationContract,
  getVideoGenerationContract,
  listVideoGenerationsContract,
  listVideoModelsContract,
  cancelMusicGenerationContract,
  createMusicGenerationContract,
  getMusicGenerationContract,
  listMusicGenerationsContract,
  listMusicModelsContract,
  cancelSceneCompositionContract,
  createSceneCompositionContract,
  getSceneCompositionContract,
  listSceneCompositionsContract,
  listVoicesContract,
  createVoiceSessionContract,
  endVoiceSessionContract,
  listWhatsNewContract,
  getWhatsNewMediaContract,
  listProjectsContract,
  getProjectContract,
  createProjectContract,
  listArtifactsContract,
  createArtifactContract,
  getArtifactContract,
  updateArtifactContract,
  deleteArtifactContract,
  listArtifactVersionsContract,
  getArtifactVersionContract,
  createArtifactVersionContract,
  searchArtifactsContract,
  listArtifactTypesContract,
  publishArtifactContract,
  republishArtifactContract,
  unpublishArtifactContract,
  createTranscriptionUploadContract,
  createTranscriptionContract,
  updateProjectContract,
  deleteProjectContract,
  listProjectFilesContract,
  addProjectFilesContract,
  removeProjectFileContract,
  listProjectSessionsContract,
  addProjectSessionsContract,
  removeProjectSessionContract,
  removeProjectMemberContract,
  listProjectInvitesContract,
  createProjectInviteContract,
  addProjectSystemPromptsContract,
  updateProjectSystemPromptContract,
  removeProjectSystemPromptContract,
  listAgentsContract,
  getAgentContract,
  createAgentContract,
  updateAgentContract,
  deleteAgentContract,
  generateAgentAvatarContract,
  generateAgentDescriptionContract,
  generateAgentSystemPromptContract,
  enhanceAgentFieldContract,
  transferAgentCreditsContract,
  createAgentFromContextContract,
  getClaudeMarketplaceContract,
  getClaudePluginZipContract,
  getClaudeBundleZipContract,
  listSkillMarketListingsContract,
  getSkillMarketListingContract,
  publishSkillMarketListingContract,
  listMySkillMarketListingsContract,
  withdrawSkillMarketListingContract,
  submitSkillMarketListingVersionContract,
  importSkillMarketListingContract,
  rescanSkillMarketVersionContract,
  createSkillContract,
  updateSkillContract,
  listMySkillsContract,
  getSkillContract,
  listSkillMarketReviewQueueContract,
  reviewSkillMarketVersionContract,
  postSlackMessageContract,
  mintPersonaContract,
  deletePersonaContract,
  listFunctionsContract,
  getFunctionContract,
  invokeFunctionContract,
  getFunctionCallContract,
  cancelFunctionCallContract,
  createFunctionContract,
  listAuthoredFunctionsContract,
  getAuthoredFunctionContract,
  saveFunctionCodeContract,
  updateFunctionContract,
  deleteFunctionContract,
  setFunctionExamplesContract,
  runFunctionTestsContract,
  pinFunctionDataContract,
  unpinFunctionDataContract,
  setFunctionSourcesContract,
  promoteFunctionContract,
  getFunctionShareContract,
  shareFunctionContract,
  unshareFunctionContract,
  findFunctionRecipientContract,
  getFunctionCallSummaryContract,
];
