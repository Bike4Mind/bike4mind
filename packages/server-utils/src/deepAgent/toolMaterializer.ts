import { Resource } from 'sst';
import { getUserEntitlements } from '../entitlements/index';
import {
  resolveToolAvailability,
  buildSharedTools,
  UrlProvenance,
  type ToolBuilderDeps,
  type ToolBuilderCallbacks,
} from '@bike4mind/services/llm';
import { applyOrgToolPolicy } from '@bike4mind/services/llm/orgToolPolicy';
import {
  assertOwnerHasCredits,
  creditService,
  estimateGeneratedMediaUsd,
  spendFreezeService,
} from '@bike4mind/services';
import { spendFreezeSubjectForRequest } from '../billing/spendFreezeSubject';
import { aiAccessDeniedMessage } from '@bike4mind/services/userService/accountState';
import { usdToCredits } from '@bike4mind/utils';
import {
  adminSettingsRepository,
  apiKeyRepository,
  dataLakeAccessGrantRepository,
  dataLakeRepository,
  fabFileChunkRepository,
  fabFileRepository,
  fallbackLakeSettingsRepository,
  lakeAccessEventRepository,
  organizationRepository,
  projectRepository,
  questRepository,
  scopedSettingsRepository,
  sessionRepository,
  spendFreezeRepository,
  userRepository,
} from '@bike4mind/database';
import {
  getAvailableModels,
  type ApiKeyTable,
  type ICompletionBackend,
  type ICompletionOptionTools,
} from '@bike4mind/llm-adapters';
import type { RetrievalExclusionOptions } from '@bike4mind/utils/retrievalExclusion';
import {
  ForbiddenError,
  insufficientCreditsError,
  readOrgModelPolicy,
  type IUserDocument,
  type ModelInfo,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { lakeWriteToolDb } from '../dataLakes/lakeWriteToolDb';
import { buildAudioToolJobs } from '../generationJobs/audioJobWiring';
import { getFilesStorage, getGeneratedImageStorage } from '../utils/storage/index';
import { signingKey } from '../security/signingKeys';
import type { ToolMaterializer } from '@bike4mind/agents';
import { buildSystemApiKeyTable } from './resolveBackend';
import { resolveRequestBillingOrgId } from '../billing/resolveRequestBillingOrgId';
import { imageModerationIncidents } from '../moderation/imageModerationIncidents';
import { isCreditsEnforced, reserveCompletionCredits, settleCompletion } from '../billing/meterPlatformCompletion';

// Generative tools whose provider cost is billed by the tool callbacks (see estimateGeneratedMediaUsd);
// video and music jobs hold and settle their own credits.
const MEDIA_TOOLS: ReadonlySet<string> = new Set(['image_generation', 'edit_image', 'audio_generation']);

interface MediaBillingContext {
  ownerUserId: string;
  billingOrgId: string | null | undefined;
  models: ModelInfo[];
  logger: Logger;
}

function estimateMediaUsd(toolName: string, data: unknown, ctx: MediaBillingContext): number {
  try {
    return estimateGeneratedMediaUsd(toolName, data, ctx.models);
  } catch (err) {
    ctx.logger.warn(`deep agent tools: could not estimate ${toolName} media cost; not billed`, { err });
    return 0;
  }
}

/** Refuses a restricted owner with the AI-access 403; reloaded per call since standing can change mid-mission. */
async function assertMediaOwnerStanding(ownerUserId: string): Promise<void> {
  const owner = (await userRepository.findById(ownerUserId)) as IUserDocument | null;
  if (!owner) throw new ForbiddenError(`deep agent tools: owner user ${ownerUserId} not found`);
  const denial = aiAccessDeniedMessage(owner);
  if (denial) throw new ForbiddenError(denial);
}

/**
 * Media tools call onToolStart before their provider call, so this refuses there: a spend freeze on the owner
 * or the billed org (403) always, and with credits enforced (422) when the owner's balance, or their org member
 * cap, cannot cover the estimate.
 */
async function gateMediaToolStart(toolName: string, data: unknown, ctx: MediaBillingContext): Promise<void> {
  const owner = (await userRepository.findById(ctx.ownerUserId)) as IUserDocument | null;
  if (!owner) throw new ForbiddenError(`deep agent tools: owner user ${ctx.ownerUserId} not found`);
  await spendFreezeService.assertSpendNotFrozen(
    spendFreezeSubjectForRequest({ user: owner }, ctx.billingOrgId ?? null),
    {
      db: { spendFreezes: spendFreezeRepository },
    }
  );
  if (!(await isCreditsEnforced())) return;
  const usd = estimateMediaUsd(toolName, data, ctx);
  if (usd <= 0) return;
  const requiredCredits = usdToCredits(usd);
  const org = ctx.billingOrgId ? await organizationRepository.findById(ctx.billingOrgId) : null;
  if (org && creditService.isMemberCreditCapExceeded(org, owner.id, requiredCredits)) {
    throw insufficientCreditsError(creditService.MEMBER_CREDIT_CAP_MESSAGE);
  }
  assertOwnerHasCredits(org ?? owner, { requiredCredits });
}

/**
 * Runs the media tools one call at a time behind the owner-standing check. The check sits on the tool itself
 * because image_generation without a preset model returns its picker prompt before onToolStart; one at a time
 * so each credit gate reads the balance after the previous call has settled.
 */
function gateMediaTools(tools: ICompletionOptionTools[], ownerUserId: string): ICompletionOptionTools[] {
  let tail: Promise<unknown> = Promise.resolve();
  return tools.map(tool => {
    if (!MEDIA_TOOLS.has(tool.toolSchema.name)) return tool;
    const run = async (parameters?: unknown, apiKey?: string) => {
      await assertMediaOwnerStanding(ownerUserId);
      return tool.toolFn(parameters, apiKey);
    };
    return {
      ...tool,
      toolFn: (parameters?: unknown, apiKey?: string) => {
        const result = tail.then(() => run(parameters, apiKey));
        tail = result.catch(() => undefined);
        return result;
      },
    };
  });
}

/**
 * Charges a delivered image or clip to the owner (their org seat when present). Media tools call onToolFinish
 * only on delivery, so a failed call is never billed; a refusal here is logged, never thrown, since the
 * media already exists.
 */
async function settleMediaToolFinish(toolName: string, data: unknown, ctx: MediaBillingContext): Promise<void> {
  const usd = estimateMediaUsd(toolName, data, ctx);
  if (usd <= 0) return;
  try {
    const owner = (await userRepository.findById(ctx.ownerUserId)) as IUserDocument | null;
    if (!owner) throw new Error(`owner user ${ctx.ownerUserId} not found`);
    const req = { user: owner, logger: ctx.logger, headers: {} };
    const reservation = await reserveCompletionCredits(req, usd, 'mission media', {
      organizationId: ctx.billingOrgId,
    });
    const { model, provider, kind } = (data ?? {}) as { model?: string; provider?: string; kind?: string };
    await settleCompletion(reservation, req, {
      // Sound effects report no model, so label them by kind to keep them apart from speech in rollups.
      model: model ?? (kind === 'sound_effect' ? kind : toolName),
      provider: provider ?? ctx.models.find(m => m.id === model)?.backend ?? 'unknown',
      usd,
      inputTokens: 0,
      outputTokens: 0,
    });
  } catch (err) {
    ctx.logger.warn(`deep agent tools: could not charge delivered ${toolName} media`, { err, usd });
  }
}

/**
 * Builds the owner-scoped b4m toolbelt for a deep agent's act step.
 *
 * Tools run as the agent's OWNER (charter.identity.ownerUserId) - their
 * storage, billing, and permissions. The agent-execution-specific machinery
 * (DAG dispatch, subagent handoff, websocket status) is intentionally omitted,
 * so `coordinate_task`/`delegate_to_agent` are simply not registered; the deep
 * agent gets the plain toolbelt (e.g. retrieve_knowledge_content, bash_execute,
 * create_file) filtered to its profile's `enabledToolNames`.
 *
 * NOTE: this performs real, side-effecting tool execution under a real user.
 * It is opt-in (wired only when `buildTools` is supplied to buildDefaultWakeDeps)
 * and should be smoke-tested on a preview env before production activation.
 */
export interface DeepAgentToolMaterializerConfig {
  llm: ICompletionBackend;
  model: string;
  logger: Logger;
  /**
   * Generic retrieval exclusion forwarded to the owner-scoped knowledge tools. Deep agents
   * run from a charter (ownerUserId), not a chat session, so there is no session-level field
   * to read here today - this stays a threadable pass-through: a caller with session context
   * can supply it, otherwise retrieval is unfiltered (unchanged behavior). Kept explicit so
   * this path is not silently unable to exclude if a session-aware caller is added later.
   */
  retrievalFilter?: RetrievalExclusionOptions;
}

export function createDeepAgentToolMaterializer(config: DeepAgentToolMaterializerConfig): ToolMaterializer {
  return async (enabledToolNames: string[], ownerUserId: string, trustedText: string[] = []) => {
    if (enabledToolNames.length === 0) return [];

    const owner = (await userRepository.findById(ownerUserId)) as IUserDocument | null;
    if (!owner) {
      throw new Error(`deep agent tools: owner user ${ownerUserId} not found`);
    }

    const apiKeyTable = await buildSystemApiKeyTable(config.logger);
    // Resolved for the OWNER, not the system identity the key table above uses. That table only
    // backs the model; every key-gated tool resolves its own key from `context.userId` at call
    // time, which is `toolDeps.userId` = ownerUserId below - so resolving as 'system' here would
    // gate on keys the tools never use. Fail-closed: a deep agent runs headless, with nobody to
    // add a missing key mid-wake. Never rejects, so it is safe in this Promise.all.
    // Wakes bill the owner's org seat (missionWakeMeter), so that org's tool policy governs the toolbelt.
    const billingOrgId = resolveRequestBillingOrgId({ user: owner });
    const [models, toolAvailability, billingOrg] = await Promise.all([
      getAvailableModels(apiKeyTable as ApiKeyTable),
      resolveToolAvailability(
        ownerUserId,
        { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository } },
        { onLookupError: 'unavailable', logger: config.logger }
      ),
      billingOrgId ? organizationRepository.findById(billingOrgId) : null,
    ]);
    const orgToolPolicy = readOrgModelPolicy(billingOrg?.modelPolicy);

    // No organizationId: a charter carries only its owner, so lake tools here stay personal. Inferring an
    // org from a linked agent would let a background mission write into an org the owner never chose.
    const urlProvenance = new UrlProvenance();
    urlProvenance.recordText(trustedText);
    const toolDeps: ToolBuilderDeps = {
      urlProvenance,
      userId: ownerUserId,
      user: owner,
      getEntitlements: () => getUserEntitlements(owner),
      logger: config.logger,
      retrievalFilter: config.retrievalFilter,
      db: {
        apiKeys: apiKeyRepository,
        adminSettings: adminSettingsRepository,
        fabfiles: fabFileRepository,
        fabfilechunks: fabFileChunkRepository,
        users: userRepository,
        projects: projectRepository,
        dataLakes: dataLakeRepository,
        dataLakeAccessGrants: dataLakeAccessGrantRepository,
        fallbackLakeSettings: fallbackLakeSettingsRepository,
        // Audit trail for images blocked by the image_generation/edit_image tools'
        // moderation gate. The gate itself is unconditional (constructed
        // inline in the tool) - this only wires the incident record, not the block.
        imageModerationIncidents,
        // Owner lookup for edit_image's generated-image keys (resolveOwnedGeneratedImageUrl). Narrow on
        // purpose: the whole repo would also enable incrementImageCount, which this host never wired.
        quests: questRepository,
        sessions: { findAllByIds: sessionRepository.findAllByIds.bind(sessionRepository) },
        organizations: organizationRepository,
        lakeAccessEvents: lakeAccessEventRepository,
        scopedSettings: scopedSettingsRepository,
        ...lakeWriteToolDb,
      },
      storage: getFilesStorage(),
      imageGenerateStorage: getGeneratedImageStorage(),
      imageProcessorLambdaName: Resource.ImageProcessor.name,
      llm: config.llm,
      model: config.model,
      precomputed: { adminSettingsEnforceCredits: false, models },
      apiKeyTable: apiKeyTable as ApiKeyTable,
      // Deep agents wake on their own schedule; no request authenticated the turn.
      authOrigin: 'internal',
    };

    // Deep agents are headless (no websocket/quest doc to update). LLM calls are billed by the wake meter;
    // only the media tools' provider cost is gated and charged here.
    const media: MediaBillingContext = { ownerUserId, billingOrgId, models, logger: config.logger };
    const toolCallbacks: ToolBuilderCallbacks = {
      onStatusUpdate: async () => {},
      onToolStart: async (toolName, data) => {
        if (MEDIA_TOOLS.has(toolName)) await gateMediaToolStart(toolName, data, media);
      },
      onToolFinish: async (toolName, data) => {
        if (MEDIA_TOOLS.has(toolName)) await settleMediaToolFinish(toolName, data, media);
      },
    };

    // deep_research is gated behind a config flag in generateTools; enable it so
    // it materializes when a profile requests it.
    const tools =
      buildSharedTools(toolDeps, toolCallbacks, {
        enabledTools: enabledToolNames,
        config: {
          deep_research: true,
          web_search: { imageUrlSigningSecret: signingKey('search-image-url') },
          audio_generation: { jobs: buildAudioToolJobs() },
        },
        toolAvailability,
        orgToolPolicy,
      }) ?? [];
    return gateMediaTools(applyOrgToolPolicy(tools, orgToolPolicy).tools, ownerUserId);
  };
}
