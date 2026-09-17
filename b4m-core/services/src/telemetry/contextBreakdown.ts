import { createHash } from 'crypto';
import type { PromptMeta, SystemPromptDetail } from '@bike4mind/common';
import { sortDetailsByDeliveryOrder } from '../llm/systemPromptFloorTelemetry';

/** Per-turn retrieval verdict, passed through verbatim - it holds counts and enums, no content. */
export type ContextBreakdownRetrieval = NonNullable<PromptMeta['retrieval']>;

export type ContextBreakdownLayer = {
  source: SystemPromptDetail['source'];
  name: string;
  tokenCount: number;
  wasIncluded: boolean;
  exclusionReason?: SystemPromptDetail['exclusionReason'];
};

export type ContextBreakdownTool = {
  name: string;
  /** The model was handed this tool's schema, whether or not it called it. */
  offered: boolean;
  invocations: number;
  successes: number;
  failures: number;
  /** Summed wall time across this tool's calls; absent when no call reported one. */
  durationMs?: number;
};

export type ContextBreakdownCategories = {
  /** Sum of the included layers, which is what the model was actually handed. */
  systemPrompt: number;
  /** The assembler's own system-prompt total, for reconciling against `systemPrompt`. */
  systemPromptResidual: number;
  toolDefinitions: number;
  attachedFiles: number;
  conversationHistory: number;
  memory: number;
  urlContent: number;
  userMessage: number;
};

export type ContextBreakdown = {
  questId: string;
  capturedAt: string | null;
  model: { id: string | null; backend: string | null };
  categories: ContextBreakdownCategories;
  layers: ContextBreakdownLayer[];
  tools: ContextBreakdownTool[];
  retrieval: ContextBreakdownRetrieval | null;
  cache: {
    readTokens: number;
    writeTokens: number;
    /** Share of the turn's cacheable tokens that were read rather than written. */
    hitRate: number;
    settledBasis: 'provider' | 'local' | null;
  };
  window: {
    contextWindow: number | null;
    inputTokens: number;
    outputTokens: number;
    maxOutputTokens: number;
    /** Null when the model's window is unknown. Negative means the turn overflowed its reservation. */
    freeSpace: number | null;
  };
  /** sha256 over `source:name:tokenCount` of the included layers in delivery order, first 12 hex. */
  promptFingerprint: string;
};

const EMPTY_CATEGORIES: ContextBreakdownCategories = {
  systemPrompt: 0,
  systemPromptResidual: 0,
  toolDefinitions: 0,
  attachedFiles: 0,
  conversationHistory: 0,
  memory: 0,
  urlContent: 0,
  userMessage: 0,
};

function buildLayers(details: SystemPromptDetail[] | undefined): ContextBreakdownLayer[] {
  if (!details?.length) return [];
  return sortDetailsByDeliveryOrder(details).map(detail => ({
    source: detail.source,
    name: detail.name,
    tokenCount: detail.tokenCount,
    wasIncluded: detail.wasIncluded,
    ...(detail.exclusionReason ? { exclusionReason: detail.exclusionReason } : {}),
  }));
}

function buildTools(promptMeta: PromptMeta): ContextBreakdownTool[] {
  const byName = new Map<string, ContextBreakdownTool>();
  for (const name of promptMeta.offeredTools ?? []) {
    if (!byName.has(name)) byName.set(name, { name, offered: true, invocations: 0, successes: 0, failures: 0 });
  }

  const durations = new Map<string, number>();
  for (const call of promptMeta.functionCalls ?? []) {
    if (!call.name) continue;
    const tool = byName.get(call.name) ?? {
      name: call.name,
      offered: false,
      invocations: 0,
      successes: 0,
      failures: 0,
    };
    tool.invocations += 1;
    if (call.success === false) tool.failures += 1;
    else if (call.success === true) tool.successes += 1;
    if (typeof call.executionTime === 'number') {
      durations.set(call.name, (durations.get(call.name) ?? 0) + call.executionTime);
    }
    byName.set(call.name, tool);
  }

  return [...byName.values()].map(tool => {
    const durationMs = durations.get(tool.name);
    return durationMs === undefined ? tool : { ...tool, durationMs };
  });
}

function fingerprintLayers(layers: ContextBreakdownLayer[]): string {
  const included = layers.filter(layer => layer.wasIncluded);
  if (included.length === 0) return '';
  const material = included.map(layer => `${layer.source}:${layer.name}:${layer.tokenCount}`).join('|');
  return createHash('sha256').update(material).digest('hex').slice(0, 12);
}

/**
 * Project a quest's stored `promptMeta` into the per-layer context breakdown the /context view
 * renders.
 *
 * Whitelisting is the point: every field is copied out by name, nothing is spread. `context` holds
 * the user's own message text under two keys (`systemPrompt` and `userPrompt`, both set by
 * ChatCompletionInvoke) and `functionCalls[]` entries hold verbatim tool output, so a spread here
 * would hand a response boundary content it has no business carrying.
 *
 * Pure, and tolerant of a quest recorded before any of these fields existed: absent input yields a
 * zeroed but structurally complete breakdown rather than throwing.
 */
export function buildContextBreakdown(
  promptMeta: PromptMeta | null | undefined,
  options: { questId: string }
): ContextBreakdown {
  const context = promptMeta?.context;
  const tokensBySource = context?.tokensBySource;
  const tokenUsage = promptMeta?.tokenUsage;
  const model = promptMeta?.model;

  const layers = buildLayers(context?.systemPromptDetails);

  const categories: ContextBreakdownCategories = tokensBySource
    ? {
        systemPrompt: layers.reduce((sum, layer) => sum + (layer.wasIncluded ? layer.tokenCount : 0), 0),
        systemPromptResidual: tokensBySource.systemPrompts,
        toolDefinitions: tokensBySource.toolSchemas,
        attachedFiles: tokensBySource.fabFiles,
        conversationHistory: tokensBySource.conversationHistory,
        memory: tokensBySource.mementos,
        urlContent: tokensBySource.urlContent,
        userMessage: tokensBySource.userPrompt,
      }
    : {
        ...EMPTY_CATEGORIES,
        systemPrompt: layers.reduce((sum, layer) => sum + (layer.wasIncluded ? layer.tokenCount : 0), 0),
      };

  const readTokens = tokenUsage?.cacheReadInputTokens ?? 0;
  const writeTokens = tokenUsage?.cacheCreationInputTokens ?? 0;
  const cacheable = readTokens + writeTokens;

  const contextWindow = model?.contextWindow ?? null;
  const inputTokens = tokenUsage?.inputTokens ?? 0;
  // The turn's own reservation, not the model's ceiling: that is what was withheld from the input.
  const maxOutputTokens = model?.parameters?.maxTokens ?? model?.maxTokens ?? 0;

  return {
    questId: options.questId,
    capturedAt: promptMeta?.generatedAt ?? null,
    model: { id: model?.name ?? null, backend: model?.backend ?? null },
    categories,
    layers,
    tools: buildTools(promptMeta ?? {}),
    retrieval: promptMeta?.retrieval ?? null,
    cache: {
      readTokens,
      writeTokens,
      hitRate: cacheable === 0 ? 0 : readTokens / cacheable,
      settledBasis: tokenUsage?.settledBasis ?? null,
    },
    window: {
      contextWindow,
      inputTokens,
      outputTokens: tokenUsage?.outputTokens ?? 0,
      maxOutputTokens,
      freeSpace: contextWindow === null ? null : contextWindow - inputTokens - maxOutputTokens,
    },
    promptFingerprint: fingerprintLayers(layers),
  };
}
