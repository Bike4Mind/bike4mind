#!/usr/bin/env tsx
/**
 * Add a question set to an existing capture without re-reading the corpus.
 *
 * PHASE E. The corpus vectors are the expensive half of a capture and they are already on disk; the
 * queries are cents. This embeds only the questions the fixture does not already hold, copies the
 * chunk lines byte for byte, and writes a new fixture - so positives authored after a capture can be
 * swept against exactly the corpus the negatives were measured on. See `fixtureQueryExtension.ts`
 * for why reuse is keyed on the question TEXT and why ground truth always comes from the file.
 *
 * Needs a live Mongo (to resolve whose provider key pays) and a provider key. Read-only against the
 * corpus: it issues no FabFile or FabFileChunk query at all, which is the point - the only prod
 * contact is the credential lookup. `connectDB` itself is not write-free; see the capture's docblock.
 *
 *   npx sst shell --stage production -- tsx packages/scripts/retrieval/extend-fixture-queries.ts \
 *     --fixture out/text-embedding-3-small.opti-knowledge.fixture.ndjson \
 *     --questions <path to the combined question file> \
 *     --userId <your user id> \
 *     --out out/text-embedding-3-small.opti-knowledge.combined.fixture.ndjson --dry-run
 *
 * Drop --dry-run and add --yes to embed. --dry-run needs no credential and no connection, so the
 * plan - which ids are new, reworded, or dropped - can be checked off-stage before anything is spent.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Resource } from 'sst';
import { adminSettingsRepository, apiKeyRepository, connectDB } from '@bike4mind/database';
import { apiKeyService } from '@bike4mind/services';
import { EmbeddingFactory, getProviderFromModel, resolveEmbeddingConfig } from '@bike4mind/fab-pipeline';
import { getSettingsByNames } from '@bike4mind/utils';
import { ApiKeyType, isSupportedEmbeddingModel } from '@bike4mind/common';
import { parseProbeQuestions } from './corpus';
import { assertOnePerInput, embedAll, parseSupportedModels } from './capturePlan';
import { readEmbeddingFixtureHeader, rewriteFixtureQueries } from './embeddingFixture';
import { assembleExtendedQueries, formatQueryExtensionPlan, planQueryExtension } from './fixtureQueryExtension';

const argv = await yargs(hideBin(process.argv))
  .option('fixture', { type: 'string', demandOption: true, describe: 'The capture to extend (read-only)' })
  .option('questions', {
    type: 'string',
    demandOption: true,
    describe: 'JSON question file whose set the new capture will carry, verbatim and in its order',
  })
  .option('userId', {
    type: 'string',
    demandOption: true,
    describe: 'User whose effective API key pays for the new query embeddings; pass your own id',
  })
  .option('out', { type: 'string', demandOption: true, describe: 'Path for the new capture' })
  .option('dry-run', { type: 'boolean', default: false, describe: 'Print the plan, then stop' })
  .option('yes', { type: 'boolean', default: false, describe: 'Approve embedding the new queries' })
  .strict()
  .parse();

// Header only: parsing the chunk lines to answer a question about the queries would load the whole
// corpus, and the splice never needs a single chunk vector in memory.
const { header } = readEmbeddingFixtureHeader(argv.fixture);
const questions = parseProbeQuestions(JSON.parse(readFileSync(argv.questions, 'utf8')) as unknown, argv.questions);
const plan = planQueryExtension({ existing: header.queries, questions });

const positives = questions.filter(q => q.supporting.length > 0).length;
console.log(
  `${header.model}@${header.dims} on ${header.corpus}: ${header.chunkCount} chunks captured ` +
    `${header.capturedAt}\n` +
    `question file        : ${questions.length} question(s) - ${positives} positive, ` +
    `${questions.length - positives} negative\n` +
    formatQueryExtensionPlan(plan)
);

if (plan.toEmbed.length === 0) {
  // Not an error: it means the capture already answers this file, and rewriting it still has a
  // point, since `supporting` may have moved and the query ORDER is the file's.
  console.log('\nNothing to embed; rewriting the query set from the file alone.');
} else if (!isSupportedEmbeddingModel(header.model)) {
  // Checked here rather than only at the spend site below, so --dry-run reports it instead of the
  // run failing after --yes. A synthetic capture may legitimately carry an unregistered model and
  // still have its query set rewritten - what it cannot do is have new questions embedded into a
  // space named by a label the registry does not know.
  throw new Error(
    `Capture "${argv.fixture}" is labelled "${header.model}", which is not a supported embedding ` +
      `model, and ${plan.toEmbed.length} question(s) would have to be embedded. A vector from a ` +
      'provider picked by a typo would not be in the same space as the corpus.'
  );
}
if (argv['dry-run']) {
  console.log('\n--dry-run: nothing embedded, nothing written.');
  process.exit(0);
}
if (plan.toEmbed.length > 0 && !argv.yes) {
  throw new Error(
    `Refusing to embed ${plan.toEmbed.length} question(s) without --yes. Re-run with --yes once the ` +
      'plan above is what you meant to ask.'
  );
}

let embedded: number[][] = [];
if (plan.toEmbed.length > 0) {
  await connectDB(Resource.MONGODB_URI.value.replace('%STAGE%', Resource.App.stage));

  // Same resolution order the capture prints and the served path uses: personal key, then platform,
  // then env. --userId therefore decides whose quota this spends, so it is reported rather than
  // assumed.
  const personalKeys = await apiKeyRepository.findByUserIdAndTypes(argv.userId, [
    ApiKeyType.openai,
    ApiKeyType.voyageai,
  ]);
  const personalTypes = personalKeys.filter(k => !k.expiresAt || k.expiresAt > new Date()).map(k => k.type);
  console.log(
    personalTypes.length > 0
      ? `credential source    : PERSONAL key(s) of user ${argv.userId} (${personalTypes.join(', ')})`
      : `credential source    : platform key / env (user ${argv.userId} stores no active provider key).`
  );

  const keyTable = await apiKeyService.getEffectiveLLMApiKeys(argv.userId, {
    db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
    getSettingsByNames,
  });
  // A fixture's `model` is only `z.string().min(1)`, deliberately - the schema has to admit the
  // synthetic captures the harness tests itself with. So it is validated against the shipped registry
  // HERE, at the one place it decides which provider gets paid: a typo'd label would otherwise pick a
  // provider by prefix and embed the new queries into a different space than the corpus.
  const [model] = parseSupportedModels([header.model]);
  const { config, missing } = resolveEmbeddingConfig(getProviderFromModel(model), keyTable);
  if (missing) {
    throw new Error(`No ${missing} credential resolved for user ${argv.userId}; cannot embed with ${model}.`);
  }
  const service = new EmbeddingFactory(config).createEmbeddingService(model);

  const texts = plan.toEmbed.map(q => q.question);
  embedded = await embedAll(service, texts);
  assertOnePerInput(embedded, texts.length, `${model} new queries`);
}

// Always through the assembler, even with nothing embedded: it is what puts the queries in the
// question file's order, which the sweep reads positionally.
const queries = assembleExtendedQueries({ plan, questions, embedded });

mkdirSync(path.dirname(path.resolve(argv.out)), { recursive: true });
const written = rewriteFixtureQueries({ source: argv.fixture, out: argv.out, queries });
console.log(
  `\nWrote ${argv.out}: ${written.queries} queries over ${written.chunkLines} chunk lines copied from ` +
    `"${argv.fixture}". Same corpus, same capture timestamp - only the questions changed.`
);
process.exit(0);
