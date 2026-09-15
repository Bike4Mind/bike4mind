import { Logger } from '@bike4mind/observability';
import dotenv from 'dotenv';
import fs, { existsSync } from 'fs';
import path from 'path';
import { connectDB } from '@bike4mind/database';
import { Resource } from 'sst';

dotenv.config();

class SyncTranslation {
  /**
   * Resolve the MongoDB connection string. Prefer an explicit MONGODB_URI env
   * var; otherwise fall back to the SST-linked resource for the current stage,
   * so running under `sst shell` works without bridging the env var manually.
   */
  private resolveMongoUri(): string | undefined {
    if (process.env.MONGODB_URI) return process.env.MONGODB_URI;
    let uri: string;
    try {
      uri = Resource.MONGODB_URI.value;
    } catch {
      // Resource access throws when not running under an SST context.
      return undefined;
    }
    // Parity with migrationManager.ts / dropPreviewDatabase.ts: the linked secret
    // must be stage-templated, otherwise the %STAGE% substitution is a silent
    // no-op and we could point the sync at the wrong stage's database.
    if (!uri.includes('%STAGE%')) {
      throw new Error(
        'Resource.MONGODB_URI is missing the %STAGE% placeholder — refusing to guess the target database. Set MONGODB_URI explicitly to override.'
      );
    }
    return uri.replace('%STAGE%', Resource.App.stage);
  }

  public async run(): Promise<number> {
    const mongoUri = this.resolveMongoUri();
    if (!mongoUri) {
      console.error(
        'Could not resolve MongoDB URI — set MONGODB_URI directly, or run under `sst shell` so it resolves from Resource for the current stage. See apps/client/app/locales/README.md.'
      );
      return 1;
    }

    const cwd = process.env.INIT_CWD || process.cwd();

    // English base is the build-time bundled source of truth in app/locales/. It
    // is the single English copy: public/locales/ holds only the other languages,
    // which this script generates from the base. (See apps/client/app/locales/README.md.)
    const baseFilePath = path.join(cwd, 'apps', 'client', 'app', 'locales', 'en.json');
    if (!existsSync(baseFilePath)) {
      console.error('English base translation file does not exist:', baseFilePath);
      return 1;
    }

    const localesPath = path.join(cwd, 'apps', 'client', 'public', 'locales');
    if (!existsSync(localesPath)) {
      console.error('Client locales path does not exist:', localesPath);
      return 1;
    }
    const files = fs.readdirSync(localesPath);

    // Translate each locale file. en.json no longer lives here, but skip it
    // defensively so a stray copy can never be treated as a target.
    let hadFailure = false;
    for (const file of files) {
      if (file === 'en.json') continue;

      const targetFilePath = path.join(localesPath, file);

      const ok = await this.syncTranslations(baseFilePath, targetFilePath, file.replace('.json', ''), mongoUri);
      if (!ok) hadFailure = true;
    }

    // Exit non-zero if any locale failed, so a CI/automation run surfaces the
    // failure instead of silently "succeeding" while some languages were skipped.
    return hadFailure ? 1 : 0;
  }

  private async deepMergeAndCollectUntranslated(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    baseObj: Record<string, any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    targetObj: Record<string, any>,
    untranslated: Record<string, string>,
    prefix: string = ''
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<Record<string, any>> {
    const updatedTargetObj: Record<string, unknown> = {};

    for (const key in baseObj) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (!(key in targetObj)) {
        if (typeof baseObj[key] === 'object' && baseObj[key] !== null) {
          updatedTargetObj[key] = await this.deepMergeAndCollectUntranslated(baseObj[key], {}, untranslated, fullKey);
        } else {
          // Collect untranslated keys
          untranslated[fullKey] = baseObj[key];
          updatedTargetObj[key] = baseObj[key]; // Temporarily use the English value
        }
      } else if (typeof baseObj[key] === 'object' && baseObj[key] !== null) {
        // If the target is not an object, but the base is, convert the target to an object
        let nextTarget = targetObj[key];
        if (typeof nextTarget !== 'object' || nextTarget === null) {
          // Optionally preserve the string as a "title" field
          if (typeof nextTarget === 'string') {
            nextTarget = { title: nextTarget };
          } else {
            nextTarget = {};
          }
        }
        updatedTargetObj[key] = await this.deepMergeAndCollectUntranslated(
          baseObj[key],
          nextTarget,
          untranslated,
          fullKey
        );
      } else {
        updatedTargetObj[key] = targetObj[key];
      }
    }
    return updatedTargetObj;
  }

  private async translateWithLLM(
    untranslated: Record<string, string>,
    targetLang: string,
    mongoUri: string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<Record<string, any>> {
    // Prepare the prompt for the LLM
    const prompt = `Translate the following JSON object from English to ${targetLang}. Only translate the values, keep the keys as they are:

    ${JSON.stringify(untranslated, null, 2)}

    Respond with the translated JSON object only, no additional text, do not wrap in a code block.
    For example:
    {
      "key1": "translated value 1",
      "key2": "translated value 2"
    }
    `;

    // The translation model + API keys are resolved from the database (system
    // keys) by OperationsModelService below - not from a process.env key - so
    // there's no upfront env-key/model availability gate here.
    const { OperationsModelService } = await import('../../apps/client/services/operationsModelService');

    let translation = '';

    try {
      // Connect to database - URI is resolved once in run() and threaded down.
      await connectDB(mongoUri, new Logger({}));

      // Get operations model info
      const { modelId, modelInfo, llm } = await OperationsModelService.getOperationsModel();

      console.log('Using operations model for translation:', {
        textModel: modelId,
        textModelName: modelInfo.name,
      });

      if (!llm) throw new Error(`No LLM found for model ${modelInfo.id}`);

      console.log(`🔁 Translating JSON object to ${targetLang}...`);
      await llm.complete(
        modelInfo.id,
        [
          {
            role: 'user',
            content: prompt,
          },
        ],
        {},
        async (streamedText: any) => {
          for (const message of streamedText) {
            if (typeof message !== 'string') return;
            translation += message;
          }
        }
      );

      // Some models wrap the JSON in a ```json fence despite the prompt asking
      // them not to; strip it defensively so a future model swap can't crash the run.
      const cleaned = translation
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();
      const translated = JSON.parse(cleaned);
      console.log('🔁 Translation completed');
      return translated;
    } catch (error) {
      console.error(`Failed to parse translated JSON: ${translation}`);
      throw error;
    }
  }

  private async syncTranslations(
    baseFilePath: string,
    targetFilePath: string,
    targetLang: string,
    mongoUri: string
  ): Promise<boolean> {
    console.log(`🔄 Syncing translations for ${targetLang}.json...`);
    try {
      const baseJSON = JSON.parse(fs.readFileSync(baseFilePath, 'utf-8'));
      const targetJSON = JSON.parse(fs.readFileSync(targetFilePath, 'utf-8'));

      const untranslated: Record<string, string> = {};
      const updatedTargetJSON = await this.deepMergeAndCollectUntranslated(baseJSON, targetJSON, untranslated);
      console.log(`🔍 Found ${Object.keys(untranslated).length} untranslated keys in ${targetLang}.json`);

      if (Object.keys(untranslated).length > 0) {
        const translations = await this.translateWithLLM(untranslated, targetLang, mongoUri);
        console.log(`🔤 Translated ${Object.keys(translations).length} keys for ${targetLang}.json`);

        // Apply translations
        console.log(`🔄 Applying translations for ${targetLang}.json...`);
        for (const [key, value] of Object.entries(translations)) {
          const keys = key.split('.');
          let current = updatedTargetJSON;
          for (let i = 0; i < keys.length - 1; i++) {
            current = current[keys[i]];
          }
          current[keys[keys.length - 1]] = value;
        }
      }
      fs.writeFileSync(targetFilePath, JSON.stringify(updatedTargetJSON, null, 2), 'utf-8');
      console.log(`✅ Translations synced successfully for ${targetLang}.json\n\n`);
      return true;
    } catch (error) {
      console.error(`Error syncing translations for ${targetLang}.json:`, error);
      return false;
    }
  }
}

new SyncTranslation()
  .run()
  .then(exitCode => process.exit(exitCode))
  .catch(err => {
    console.error('Error syncing translations:', err);
    process.exit(1);
  });
