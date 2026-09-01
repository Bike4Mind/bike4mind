import { adminSettingsRepository } from '@bike4mind/database';
import { isSupportedEmbeddingModel, OpenAIEmbeddingModel, type SupportedEmbeddingModel } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';

/**
 * The platform's configured embedding model, as the FLAT admin setting.
 *
 * Deliberately not the same function as `lakeAdmissionGate`'s same-named helper: that one resolves
 * through `resolveScopedSetting`, so a lake- or org-scoped override can win. This is the platform
 * answer, which is what a caller wants when it is asking "what does this deployment embed with"
 * rather than "what does this lake embed with". Kept apart on purpose; converging them would
 * silently give one set of callers the other's semantics.
 *
 * Falls back to ada-002 rather than throwing: every caller needs SOME model to proceed, and a
 * misconfigured value is otherwise indistinguishable from an empty result. Both the unsupported
 * value and the failed read are logged, because a silent fallback here means a corpus embedded
 * with a model nobody chose.
 */
export async function resolveDefaultEmbeddingModel(logger: Logger, label: string): Promise<SupportedEmbeddingModel> {
  try {
    const configured = await adminSettingsRepository.getSettingsValue('defaultEmbeddingModel');
    if (typeof configured === 'string' && isSupportedEmbeddingModel(configured)) {
      return configured as SupportedEmbeddingModel;
    }
    if (configured !== undefined && configured !== null && configured !== '') {
      logger?.warn(
        `[${label}] defaultEmbeddingModel "${String(configured)}" is not a supported embedding model; ` +
          'falling back to ada-002, which will not match a corpus vectorized with another model'
      );
    }
  } catch (err) {
    logger?.warn(`[${label}] failed to read defaultEmbeddingModel; using ada-002`, err);
  }
  return OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002;
}
