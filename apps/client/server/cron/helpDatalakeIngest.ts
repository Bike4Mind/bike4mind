/**
 * Scheduled re-sync of the `system-help` data lake against the help corpus.
 *
 * The lake is the corpus behind in-chat `search_knowledge_base`; the Help panel reads the
 * committed `help-embeddings.json` instead, and that side is already held in step at section
 * granularity by help-id-resolution.test.ts. Nothing held THIS side in step with anything, so the
 * lake was whatever the last hand-run of `help:ingest-datalake` left behind - it drifted for two
 * months in both directions at once, missing newly published articles while still serving eleven
 * that had been deleted from the corpus.
 *
 * All the mirroring logic is shared with that script (@bike4mind/scripts/help/ingestHelpDatalake),
 * so the scheduled path and the manual path cannot diverge. The shared mirror is differential -
 * it keeps every member whose body hash and embedding model still match - so a tick on an
 * unchanged corpus does no writes and spends nothing on embeddings.
 *
 * NOT the bootstrap. This handler refuses to create the lake: it resolves the file owner from the
 * existing lake's `createdByUserId`, because the owner is also whose effective LLM keys embed the
 * chunks and there is no defensible way for a cron to pick a user. An environment where nobody has
 * run the bootstrap script yet is therefore a logged no-op, not a lake owned by an arbitrary
 * account.
 *
 * The corpus arrives in the Lambda bundle via copyFiles (see infra/cron.ts) and is read from
 * `docs-site/docs` + the generated `help-index.json` - both committed, so the bundle carries them
 * whether or not `help:bundle-content` ran during the build.
 */

import {
  adminSettingsRepository,
  apiKeyRepository,
  connectDB,
  dataLakeRepository,
  fabFileChunkRepository,
  fabFileRepository,
} from '@bike4mind/database';
import { isSupportedEmbeddingModel } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { HELP_DATALAKE_SLUG, createHelpEmbedder, ingestHelpDatalake } from '@bike4mind/scripts/help/ingestHelpDatalake';
import { apiKeyService } from '@bike4mind/services';
import { getSettingsByNames } from '@bike4mind/utils';
import { Config } from '@server/utils/config';
import * as path from 'path';
import { Resource } from 'sst';

const logger = new Logger({ metadata: { service: 'helpDatalakeIngest' } });

/**
 * Where infra/cron.ts's copyFiles lands the corpus, relative to the Lambda task root. MUST STAY
 * IN SYNC with the `to:` paths on the helpDatalakeIngest cron.
 */
const CORPUS_DIR = 'help-corpus';

const corpusRoot = (): string => path.join(process.env.LAMBDA_TASK_ROOT ?? process.cwd(), CORPUS_DIR);

export async function handler() {
  const stage = Resource.App.stage;
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', stage));

  // Owner comes from the lake, never from this handler - see the no-bootstrap note above.
  const lake = await dataLakeRepository.findBySlug(HELP_DATALAKE_SLUG);
  if (!lake) {
    logger.warn('[helpDatalakeIngest] no system-help lake; run help:ingest-datalake once to bootstrap it');
    return { statusCode: 200, body: JSON.stringify({ skipped: 'lake-missing' }) };
  }

  const embeddingModel = await adminSettingsRepository.getSettingsValue('defaultEmbeddingModel');
  if (!embeddingModel || !isSupportedEmbeddingModel(embeddingModel)) {
    logger.error('[helpDatalakeIngest] defaultEmbeddingModel is unset or unsupported', {
      embeddingModel: String(embeddingModel),
    });
    return { statusCode: 200, body: JSON.stringify({ skipped: 'embedding-model' }) };
  }

  const apiKeyTable = await apiKeyService.getEffectiveLLMApiKeys(lake.createdByUserId, {
    db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
    getSettingsByNames,
  });

  const root = corpusRoot();
  const result = await ingestHelpDatalake(
    {
      db: { fabFiles: fabFileRepository, fabFileChunks: fabFileChunkRepository, dataLakes: dataLakeRepository },
      embed: createHelpEmbedder(embeddingModel, apiKeyTable),
      embeddingModel,
      logger: {
        info: msg => logger.info(`[helpDatalakeIngest] ${msg}`),
        warn: msg => logger.warn(`[helpDatalakeIngest] ${msg}`),
      },
    },
    {
      userId: lake.createdByUserId,
      helpIndexPath: path.join(root, 'help-index.json'),
      helpContentRoot: path.join(root, 'docs'),
    }
  );

  // Drift that the mirror could not close by itself: an indexed article whose markdown is absent
  // from the bundle is the one case a re-run cannot fix, so it is surfaced rather than counted.
  if (result.missingContent.length > 0) {
    logger.error('[helpDatalakeIngest] indexed articles missing from the bundled corpus', {
      slugs: result.missingContent,
    });
  }

  logger.info('[helpDatalakeIngest] re-sync complete', { ...result });
  return { statusCode: 200, body: JSON.stringify(result) };
}
