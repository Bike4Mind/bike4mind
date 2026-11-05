/**
 * Scheduled re-sync of the `system-help` data lake against the help corpus.
 *
 * The lake is the corpus behind in-chat `search_knowledge_base`; the Help panel reads the
 * generated `help-embeddings.json` instead, which is rebuilt from docs-site at deploy time and so
 * cannot go stale the way a committed copy did - as long as the deploy's vectorize step runs;
 * under HELP_EMBEDDINGS_REQUIRED=false it leaves whatever is already there. Nothing held THIS side in step with anything, so the lake was whatever the
 * last hand-run of `help:ingest-datalake` left behind - it drifted for two months in both
 * directions at once, missing newly published articles while still serving eleven that had been
 * deleted from the corpus.
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
 * account. The one exception is self-host (apps/workers/src/selfhost/helpDatalakeIngest.ts),
 * which has no operator to run the script: it passes `bootstrapOwnerId`, so an install where no
 * help lake has ever existed creates one owned by its oldest admin.
 *
 * The corpus arrives in the Lambda bundle via copyFiles (see infra/cron.ts) and is read from
 * `docs-site/docs` + the generated `help-index.json`. infra/cron.ts regenerates that index as it
 * bundles, so the corpus is self-contained and does not depend on the web build having run. The
 * self-host worker image builds the same layout (apps/client/Dockerfile.chatcompletion.selfhost).
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
import {
  HELP_DATALAKE_SLUG,
  HELP_DATALAKE_TAG,
  createHelpEmbedder,
  ingestHelpDatalake,
} from '@bike4mind/scripts/help/ingestHelpDatalake';
import { apiKeyService } from '@bike4mind/services';
import { getSettingsByNames } from '@bike4mind/utils';
import { Config } from '@bike4mind/server-utils/utils/config';
import * as path from 'path';
import { Resource } from 'sst';

const logger = new Logger({ metadata: { service: 'helpDatalakeIngest' } });

/**
 * Where infra/cron.ts's copyFiles lands the corpus, relative to the Lambda task root. MUST STAY
 * IN SYNC with the `to:` paths on the helpDatalakeIngest cron.
 */
const CORPUS_DIR = 'help-corpus';

/** Under the Lambda task root on hosted; under the worker's working directory on self-host. */
export const corpusRoot = (): string => path.join(process.env.LAMBDA_TASK_ROOT ?? process.cwd(), CORPUS_DIR);

export interface HelpDatalakeIngestRunOptions {
  corpusRoot: string;
  /**
   * Self-host only: names the owner when no help lake has EVER existed, so a fresh install
   * bootstraps itself. Hosted omits it and keeps the no-bootstrap rule above. A lake that exists
   * but is deleted or purging is never revived either way. Returns null to skip this run.
   */
  bootstrapOwnerId?: () => Promise<string | null>;
}

export type HelpDatalakeIngestRunResult =
  { skipped: 'lake-missing' | 'no-owner' | 'embedding-model' } | Awaited<ReturnType<typeof ingestHelpDatalake>>;

/** One re-sync pass. The caller connects the DB. */
export async function runHelpDatalakeIngest(opts: HelpDatalakeIngestRunOptions): Promise<HelpDatalakeIngestRunResult> {
  // By slug, unlike the script's tag lookup: an unattended run must not revive a lake an admin deleted.
  const lake = await dataLakeRepository.findBySlug(HELP_DATALAKE_SLUG);
  let ownerId: string;
  if (lake) {
    // Owner comes from the lake, never from this function - see the no-bootstrap note above.
    ownerId = lake.createdByUserId;
  } else {
    // The tag lookup also sees deleted and purging lakes, so only a never-created lake bootstraps.
    const everCreated = opts.bootstrapOwnerId ? await dataLakeRepository.findByDatalakeTag(HELP_DATALAKE_TAG) : null;
    if (!opts.bootstrapOwnerId || everCreated) {
      logger.warn(
        '[helpDatalakeIngest] no live system-help lake (missing, deleted or purging); run help:ingest-datalake to bootstrap or reactivate it'
      );
      return { skipped: 'lake-missing' };
    }
    const bootstrapOwner = await opts.bootstrapOwnerId();
    if (!bootstrapOwner) {
      logger.info('[helpDatalakeIngest] no help lake yet and no admin to own it; retrying next run');
      return { skipped: 'no-owner' };
    }
    ownerId = bootstrapOwner;
    logger.info('[helpDatalakeIngest] bootstrapping the system-help lake', { ownerId });
  }

  const embeddingModel = await adminSettingsRepository.getSettingsValue('defaultEmbeddingModel');
  if (!embeddingModel || !isSupportedEmbeddingModel(embeddingModel)) {
    logger.error('[helpDatalakeIngest] defaultEmbeddingModel is unset or unsupported', {
      embeddingModel: String(embeddingModel),
    });
    return { skipped: 'embedding-model' };
  }

  const apiKeyTable = await apiKeyService.getEffectiveLLMApiKeys(ownerId, {
    db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
    getSettingsByNames,
  });

  // A keyless cloud stage embeds on Bedrock; take the model back from the embedder so the corpus
  // is stamped with what it was actually embedded with (see createHelpEmbedder).
  const { embed, model: resolvedEmbeddingModel } = createHelpEmbedder(embeddingModel, apiKeyTable);

  const root = opts.corpusRoot;
  const result = await ingestHelpDatalake(
    {
      db: { fabFiles: fabFileRepository, fabFileChunks: fabFileChunkRepository, dataLakes: dataLakeRepository },
      embed,
      embeddingModel: resolvedEmbeddingModel,
      logger: {
        info: msg => logger.info(`[helpDatalakeIngest] ${msg}`),
        warn: msg => logger.warn(`[helpDatalakeIngest] ${msg}`),
      },
    },
    {
      userId: ownerId,
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
  return result;
}

export async function handler() {
  const stage = Resource.App.stage;
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', stage));
  const result = await runHelpDatalakeIngest({ corpusRoot: corpusRoot() });
  return { statusCode: 200, body: JSON.stringify(result) };
}
