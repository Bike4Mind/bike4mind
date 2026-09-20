import { adminSettingsRepository } from '@bike4mind/database';
import { isSupportedEmbeddingModel, OpenAIEmbeddingModel, type SupportedEmbeddingModel } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';

/**
 * The platform's configured embedding model, as the FLAT admin setting.
 *
 * Deliberately not the same function as `lakeAdmissionGate`'s same-named helper - but not because
 * the answers differ. That one calls `resolveScopedSetting` with an EMPTY scope, which resolves to
 * the platform value too (its own test: "returns the platform value with an empty scope"), so
 * describing this as the un-scoped twin of a scoped resolver is wrong. What actually differs is
 * shape: this returns a validated `SupportedEmbeddingModel` and falls back to the deployment default
 * when the read throws, where that one returns a bare `string` through an injected `db` adapter.
 * Converging them means choosing one caller's failure behaviour for both, which is the reason to
 * leave them apart.
 *
 * Falls back rather than throwing: every caller needs SOME model to proceed, and a misconfigured
 * value is otherwise indistinguishable from an empty result. Both the unsupported value and the
 * failed read are logged, because a silent fallback here means a corpus embedded with a model nobody
 * chose.
 *
 * The fallback is 3-small, matching `defaultEmbeddingModelForEnv`, because that is the model new
 * work should be created in. It is NOT the assumed space of an unlabeled legacy row - that is a
 * different question with a different answer (still ada-002, see `processFabFilesServer`), and
 * conflating the two is how a mechanical flip silently reads a legacy corpus in the wrong space.
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
          `falling back to ${OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL}, which will not match a ` +
          'corpus vectorized with another model'
      );
    }
  } catch (err) {
    logger?.warn(
      `[${label}] failed to read defaultEmbeddingModel; using ${OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL}`,
      err
    );
  }
  return OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL;
}
