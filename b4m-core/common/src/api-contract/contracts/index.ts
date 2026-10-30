import type { EndpointContract } from '../types';
import { chatContract } from './chat.contract';
import { startAgentExecutionContract, getAgentExecutionContract } from './agentExecutions.contract';
import { sessionUpdateContract } from './sessionUpdate.contract';
import { sessionGetContract } from './sessionGet.contract';
import { sessionDeleteContract } from './sessionDelete.contract';
import { sessionCloneContract } from './sessionClone.contract';
import { executeToolContract } from './tools.contract';
import { createCompletionContract } from './completions.contract';
import { synthesizeSpeechContract } from './tts.contract';
import { generateMusicContract } from './music.contract';
import { generateSoundEffectContract } from './soundEffects.contract';
import { getMeContract } from './me.contract';
import { getCreditBalanceContract } from './credits.contract';
import { listModelsContract } from './models.contract';
import { generateImageContract } from './imageGeneration.contract';
import { editImageContract } from './imageEdit.contract';
import {
  createFileUploadContract,
  getFileContract,
  listFilesContract,
  updateFileContract,
  deleteFileContract,
} from './files.contract';
import { createEmbeddingsContract } from './embeddings.contract';
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
} from './artifacts.contract';
import { createTranscriptionUploadContract, createTranscriptionContract } from './transcription.contract';
import { createSessionContract } from './sessionCreate.contract';
import { listSessionsContract } from './sessionList.contract';
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
import { listVoicesContract, createVoiceSessionContract, endVoiceSessionContract } from './voice.contract';
import {
  listProjectsContract,
  getProjectContract,
  createProjectContract,
  updateProjectContract,
  deleteProjectContract,
} from './projects.contract';
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
  createCompletionContract,
  synthesizeSpeechContract,
  generateMusicContract,
  generateSoundEffectContract,
  getMeContract,
  getCreditBalanceContract,
  listModelsContract,
  generateImageContract,
  editImageContract,
  createFileUploadContract,
  getFileContract,
  listFilesContract,
  updateFileContract,
  deleteFileContract,
  createEmbeddingsContract,
  createTextRefinementContract,
  createDecisionContract,
  listDecisionModelsContract,
  getQuestContract,
  listQuestFilesContract,
  createSessionContract,
  listSessionsContract,
  listDataLakesContract,
  getDataLakeContract,
  getDataLakeFileContract,
  addDataLakeFileContract,
  removeDataLakeFileContract,
  searchDataLakeContract,
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
  createTranscriptionUploadContract,
  createTranscriptionContract,
  updateProjectContract,
  deleteProjectContract,
  listAgentsContract,
  getAgentContract,
  createAgentContract,
  updateAgentContract,
  deleteAgentContract,
  generateAgentAvatarContract,
  generateAgentDescriptionContract,
  generateAgentSystemPromptContract,
  enhanceAgentFieldContract,
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
  listSkillMarketReviewQueueContract,
  reviewSkillMarketVersionContract,
];
