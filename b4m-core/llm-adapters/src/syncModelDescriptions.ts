import { ModelBackend, ModelInfo, ModelName } from '@bike4mind/common';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getAvailableModels, getLlmByModel } from './index';
import { Logger } from '@bike4mind/observability';

// ESM module dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

interface ApiKeyTable {
  openai?: string;
  anthropic?: string;
  gemini?: string;
  ollama?: string;
  bfl?: string;
  xai?: string;
}

interface CompletionInfo {
  inputTokens?: number;
  outputTokens?: number;
}

type CompletionStreamHandler = (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>;

interface ModelMetadata {
  id: ModelName;
  name: string;
  type: 'text';
  contextWindow: number;
  maxTokens: number;
  supportsVision?: boolean;
  supportsTools?: boolean;
  supportsImageVariation: boolean;
  trainingCutoff?: string;
  currentDescription?: string;
}

interface ModelInfoRequest {
  models: ModelMetadata[];
}

interface ModelUpdateInfo {
  modelId: string;
  oldDescription: string;
  newDescription: string;
  reason: string;
}

type ModelDescriptions = Record<ModelName, string>;
type ModelUpdateReasons = Record<ModelName, string>;

interface UpdateResult {
  descriptions: ModelDescriptions;
  reasons: ModelUpdateReasons;
}

class SyncModelDescriptions {
  private readonly logger: Logger;
  private readonly backendFiles: Readonly<Record<Exclude<ModelBackend, ModelBackend.VoyageAI>, string>> = {
    [ModelBackend.OpenAI]: 'openaiBackend.ts',
    [ModelBackend.Anthropic]: 'anthropicBackend.ts',
    [ModelBackend.Bedrock]: 'bedrockBackend', // Special case - directory with multiple files
    [ModelBackend.Gemini]: 'geminiBackend.ts',
    [ModelBackend.Ollama]: 'ollamaBackend.ts',
    [ModelBackend.BFL]: 'bflBackend.ts',
    [ModelBackend.XAI]: 'xaiBackend.ts',
    [ModelBackend.AWS]: 'awsBackend.ts',
  } as const;

  constructor(
    private readonly apiKey: string,
    private readonly modelId: string
  ) {
    this.logger = new Logger({
      metadata: {
        script: 'syncModelDescriptions',
      },
    });
  }

  public async run(): Promise<number> {
    try {
      // Validate API key and model ID
      if (!this.apiKey) {
        throw new Error('API key is required');
      }

      if (!this.modelId) {
        throw new Error('Model ID is required');
      }

      const apiKeyTable: ApiKeyTable = this.buildApiKeyTable();

      this.logger.info('🔍 Fetching available models...');
      const models = await getAvailableModels(apiKeyTable);

      if (models.length === 0) {
        this.logger.warn('No models found');
        return 0;
      }

      // Group models by backend with proper type checking
      const modelsByBackend = models.reduce<Record<string, ModelInfo[]>>((acc, model) => {
        const backend = model.backend;
        if (!this.isValidBackend(backend)) {
          this.logger.warn(`Invalid backend: ${backend} for model ${model.id}`);
          return acc;
        }

        if (!acc[backend]) {
          acc[backend] = [];
        }
        acc[backend].push(model);
        return acc;
      }, Object.create(null));

      // Track all model updates across backends
      const allModelUpdates: ModelUpdateInfo[] = [];

      // Update descriptions for each backend's models
      const updatePromises = Object.entries(modelsByBackend).map(async ([backend, backendModels]) => {
        this.logger.info(`\n🔄 Analyzing descriptions for ${backend} models...`);

        try {
          const updateResult = await this.getUpdatedDescriptions(backendModels);

          // Log models that need updating for this backend
          const backendUpdates = this.logModelChanges(backendModels, updateResult);
          allModelUpdates.push(...backendUpdates);

          // Apply the updated descriptions and save to file
          await this.updateBackendFile(backend as ModelBackend, updateResult.descriptions);
        } catch (error) {
          this.logger.error(
            `Failed to update ${backend} models:`,
            error instanceof Error ? error.message : String(error)
          );
          throw error; // Re-throw to fail the entire operation
        }
      });

      await Promise.all(updatePromises);

      // Log summary of all changes
      this.logUpdateSummary(allModelUpdates);

      // Cleanup old backup files after all updates are complete
      this.logger.info('\n🧹 Cleaning up old backup files...');
      await this.cleanupAllBackupFiles();

      this.logger.info('\n✅ Model descriptions analysis completed');
      return 0;
    } catch (error) {
      this.logger.error('Error updating model descriptions:', error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  private logModelChanges(models: readonly ModelInfo[], updateResult: UpdateResult): ModelUpdateInfo[] {
    const modelUpdates: ModelUpdateInfo[] = [];

    for (const model of models) {
      const newDescription = updateResult.descriptions[model.id as ModelName];
      const reason = updateResult.reasons[model.id as ModelName];

      if (newDescription && reason && model.description !== newDescription) {
        const updateInfo: ModelUpdateInfo = {
          modelId: model.id,
          oldDescription: model.description || 'No description',
          newDescription,
          reason,
        };

        modelUpdates.push(updateInfo);

        this.logger.info(`\n📝 Model Update Required: ${model.id}`);
        this.logger.info(`   Reason: ${reason}`);
        this.logger.info(`   Old: "${model.description || 'No description'}"`);
        this.logger.info(`   New: "${newDescription}"`);
      }
    }

    return modelUpdates;
  }

  private logUpdateSummary(allUpdates: ModelUpdateInfo[]): void {
    if (allUpdates.length === 0) {
      this.logger.info('\n📊 Summary: No models require description updates');
      return;
    }

    this.logger.info(`\n📊 Update Summary: ${allUpdates.length} models need updates`);

    // Group by reason type
    const reasonGroups: Record<string, ModelUpdateInfo[]> = {};
    for (const update of allUpdates) {
      const reasonKey = this.categorizeReason(update.reason);
      if (!reasonGroups[reasonKey]) {
        reasonGroups[reasonKey] = [];
      }
      reasonGroups[reasonKey].push(update);
    }

    for (const [reasonType, updates] of Object.entries(reasonGroups)) {
      this.logger.info(`\n   ${reasonType}: ${updates.length} models`);
      for (const update of updates) {
        this.logger.info(`     • ${update.modelId}: ${update.reason}`);
      }
    }
  }

  private categorizeReason(reason: string): string {
    const lowerReason = reason.toLowerCase();
    if (lowerReason.includes('cost') || lowerReason.includes('expensive') || lowerReason.includes('efficient')) {
      return 'Cost/Efficiency Updates';
    }
    if (lowerReason.includes('outdated') || lowerReason.includes('old') || lowerReason.includes('deprecated')) {
      return 'Outdated Information';
    }
    if (lowerReason.includes('capability') || lowerReason.includes('feature') || lowerReason.includes('support')) {
      return 'Capability Updates';
    }
    if (lowerReason.includes('inaccurate') || lowerReason.includes('incorrect') || lowerReason.includes('wrong')) {
      return 'Accuracy Corrections';
    }
    return 'Other Updates';
  }

  private isValidBackend(backend: unknown): backend is ModelBackend {
    return Object.values(ModelBackend).includes(backend as ModelBackend);
  }

  // Map Bedrock models to their specific backend files
  private getBedrockBackendFile(modelId: string): string {
    // Map based on model ID patterns
    if (modelId.includes('claude') || modelId.includes('anthropic')) {
      return 'bedrockBackend/anthropic.ts';
    } else if (modelId.includes('titan') || modelId.includes('amazon')) {
      return 'bedrockBackend/titan.ts';
    } else if (modelId.includes('llama') || modelId.includes('meta')) {
      return 'bedrockBackend/llama.ts';
    } else if (modelId.includes('deepseek')) {
      return 'bedrockBackend/deepseek.ts';
    } else if (modelId.includes('jurassic')) {
      return 'bedrockBackend/jurassicTwo.ts';
    } else {
      // Fallback to undifferentiated.ts for unknown models
      return 'bedrockBackend/undifferentiated.ts';
    }
  }

  // Delete all backup files across all backend directories
  private async cleanupAllBackupFiles(): Promise<void> {
    try {
      const backendDirectories = [
        __dirname, // Main llm directory
        path.join(__dirname, 'bedrockBackend'), // Bedrock subdirectory
      ];

      let totalDeleted = 0;

      for (const dir of backendDirectories) {
        if (!fs.existsSync(dir)) continue;

        const files = await fs.promises.readdir(dir);
        const backupFiles = files.filter(file => file.includes('.backup.'));

        if (backupFiles.length === 0) continue;

        this.logger.info(`🧹 Cleaning up ${backupFiles.length} backup files in ${path.basename(dir)}...`);

        // Delete all backup files immediately
        for (const backupFile of backupFiles) {
          const filePath = path.join(dir, backupFile);
          try {
            await fs.promises.unlink(filePath);
            this.logger.info(`🗑️  Deleted backup: ${backupFile}`);
            totalDeleted++;
          } catch (error) {
            this.logger.warn(`Failed to delete backup ${backupFile}:`, error);
          }
        }
      }

      if (totalDeleted > 0) {
        this.logger.info(`✅ Successfully deleted ${totalDeleted} backup files`);
      } else {
        this.logger.info(`ℹ️  No backup files found to delete`);
      }
    } catch (error) {
      this.logger.error('Failed to cleanup backup files:', error);
    }
  }

  private async debugFileFormat(backend: ModelBackend, descriptions: ModelDescriptions): Promise<void> {
    // Check if backend is supported
    if (!(backend in this.backendFiles)) {
      console.log(`❌ Backend ${backend} not supported for debugging`);
      return;
    }

    const filename = this.backendFiles[backend as keyof typeof this.backendFiles];
    const filePath = path.join(__dirname, filename);

    if (!fs.existsSync(filePath)) {
      console.log(`❌ File not found: ${filePath}`);
      return;
    }

    const content = await fs.promises.readFile(filePath, 'utf8');

    console.log(`\n=== DEBUGGING ${backend} FILE FORMAT ===`);
    console.log(`File: ${filePath}`);
    console.log(`File length: ${content.length} chars`);

    // Look for each model that needs updating
    for (const [modelId] of Object.entries(descriptions)) {
      console.log(`\n--- Searching for model: ${modelId} ---`);

      // Check if the model ID exists in the file at all
      const modelIdVariations = [
        modelId,
        `ChatModels.${modelId}`,
        `ImageModels.${modelId}`,
        `"${modelId}"`,
        `'${modelId}'`,
        modelId.replace(/-/g, '_'), // Some IDs might use underscores
      ];

      let found = false;
      for (const variation of modelIdVariations) {
        if (content.includes(variation)) {
          console.log(`✅ Found model ID variation: "${variation}"`);

          // Find the context around this model ID
          const index = content.indexOf(variation);
          const start = Math.max(0, index - 200);
          const end = Math.min(content.length, index + 600);
          const context = content.substring(start, end);

          console.log(`Context around "${variation}":`);
          console.log('---START CONTEXT---');
          console.log(context);
          console.log('---END CONTEXT---');

          found = true;
          break;
        }
      }

      if (!found) {
        console.log(`❌ Model ID not found in file: ${modelId}`);
      }
    }

    // Also show some sample model definitions from the file
    console.log(`\n--- SAMPLE FILE CONTENT ---`);
    console.log('First 1000 characters:');
    console.log(content.substring(0, 1000));
  }

  private async updateBackendFile(backend: ModelBackend, descriptions: ModelDescriptions): Promise<void> {
    // Special handling for Bedrock backend with multiple files
    if (backend === ModelBackend.Bedrock) {
      await this.updateBedrockBackendFiles(descriptions);
      return;
    }

    // Check if backend is supported
    if (!(backend in this.backendFiles)) {
      this.logger.warn(`Backend ${backend} not supported for file updates`);
      return;
    }

    const filename = this.backendFiles[backend as keyof typeof this.backendFiles];
    if (!filename) {
      this.logger.warn(`No backend file mapping found for ${backend}`);
      return;
    }

    await this.updateSingleBackendFile(filename, descriptions);
  }

  // Handle Bedrock backend with multiple files
  private async updateBedrockBackendFiles(descriptions: ModelDescriptions): Promise<void> {
    // Group models by their specific backend files
    const modelsByFile: Record<string, Record<string, string>> = {};

    for (const [modelId, newDescription] of Object.entries(descriptions)) {
      const specificFile = this.getBedrockBackendFile(modelId);
      if (!modelsByFile[specificFile]) {
        modelsByFile[specificFile] = {};
      }
      modelsByFile[specificFile][modelId] = newDescription;
    }

    // Update each file separately
    for (const [filename, fileModels] of Object.entries(modelsByFile)) {
      console.log(`\n🔄 Updating ${filename} with ${Object.keys(fileModels).length} models...`);
      await this.updateSingleBackendFile(filename, fileModels);
    }
  }

  // Update a single backend file
  private async updateSingleBackendFile(filename: string, descriptions: Record<string, string>): Promise<void> {
    const filePath = path.join(__dirname, filename);

    if (!fs.existsSync(filePath)) {
      this.logger.error(`File does not exist: ${filePath}`);
      return;
    }

    let content: string;
    try {
      content = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      this.logger.error(`Failed to read file: ${filePath}`);
      throw error;
    }

    // Create backup
    const backupPath = `${filePath}.backup.${Date.now()}`;
    try {
      await fs.promises.writeFile(backupPath, content, 'utf8');
      this.logger.info(`Created backup: ${backupPath}`);
    } catch (error) {
      this.logger.error(`Failed to create backup: ${backupPath}`);
      throw error;
    }

    let updatedContent = content;
    let updatedCount = 0;

    // For each model that needs updating
    for (const [modelId, newDescription] of Object.entries(descriptions)) {
      console.log(`\n=== Updating ${modelId} ===`);

      // Find all possible ways this model might be referenced
      const modelReferences = this.findAllModelReferences(content, modelId);

      if (modelReferences.length === 0) {
        console.log(`❌ Could not find any references to model: ${modelId}`);

        // Enhanced debugging - show what we're looking for vs what exists
        console.log(`\n--- DEBUGGING MODEL SEARCH ---`);
        await this.debugModelSearch(content, modelId);
        continue;
      }

      console.log(`✅ Found ${modelReferences.length} potential references`);
      modelReferences.forEach((ref, i) => {
        console.log(`  ${i + 1}. ${ref.type}: ${ref.value}`);
      });

      // Try different update strategies
      let updated = false;

      // Strategy 1: Update using constant references (most common for Bedrock)
      for (const ref of modelReferences) {
        if (ref.type === 'constant') {
          console.log(`\nTrying to update via constant: ${ref.value}`);

          // More robust pattern that handles multi-line descriptions
          const constantPattern = new RegExp(
            `(id:\\s*${this.escapeRegex(ref.value)}[\\s\\S]*?description:\\s*)(["'\`])([\\s\\S]*?)\\2(?=\\s*[,}])`,
            'g'
          );

          const constantMatch = constantPattern.exec(content);
          if (constantMatch) {
            const [fullMatch, prefix, quote, oldDescription] = constantMatch;
            console.log(`Found match with constant pattern`);
            console.log(`  Prefix: "${prefix.substring(0, 50)}..."`);
            console.log(`  Quote: "${quote}"`);
            console.log(`  Old desc: "${oldDescription}"`);

            if (oldDescription.trim() !== newDescription.trim()) {
              const replacement = `${prefix}${quote}${this.escapeDescription(newDescription)}${quote}`;
              updatedContent = updatedContent.replace(fullMatch, replacement);
              updatedCount++;
              updated = true;
              console.log(`✅ Updated via constant pattern: ${ref.value}`);
              console.log(`   Old: "${oldDescription}"`);
              console.log(`   New: "${newDescription}"`);
              break;
            } else {
              console.log(`Description already up to date`);
            }
          } else {
            console.log(`No match found with constant pattern for: ${ref.value}`);
          }
        }
      }

      // Strategy 2: Update using direct model ID strings (fallback)
      if (!updated) {
        for (const ref of modelReferences) {
          if (ref.type === 'string') {
            console.log(`\nTrying to update via string: ${ref.value}`);

            const stringPattern = new RegExp(
              `(id:\\s*["'\`]${this.escapeRegex(modelId)}["'\`][\\s\\S]*?description:\\s*)(["'\`])([\\s\\S]*?)\\2`,
              'g'
            );

            const match = stringPattern.exec(content);
            if (match) {
              const [fullMatch, prefix, quote, oldDescription] = match;

              if (oldDescription.trim() !== newDescription.trim()) {
                updatedContent = updatedContent.replace(
                  fullMatch,
                  `${prefix}${quote}${this.escapeDescription(newDescription)}${quote}`
                );
                updatedCount++;
                updated = true;
                console.log(`✅ Updated via string pattern`);
                console.log(`   Old: "${oldDescription}"`);
                console.log(`   New: "${newDescription}"`);
                break;
              }
            }
          }
        }
      }

      if (!updated) {
        console.log(`❌ Failed to update ${modelId} - no matching patterns worked`);

        // Show what patterns we tried
        console.log(`\nPatterns attempted:`);
        for (const ref of modelReferences) {
          if (ref.type === 'constant') {
            const pattern = `id:\\s*${this.escapeRegex(ref.value)}[\\s\\S]*?description:`;
            console.log(`  Constant pattern: ${pattern}`);
          }
        }
      }
    }

    console.log(`\nFinal update count: ${updatedCount}`);
    console.log(`Content changed: ${content !== updatedContent}`);

    // Only write if there were changes
    if (updatedCount > 0) {
      try {
        await fs.promises.writeFile(filePath, updatedContent, 'utf8');
        this.logger.info(`Applied ${updatedCount} description updates to ${path.basename(filename)}`);
      } catch (error) {
        this.logger.error(`Failed to write updated file: ${filePath}`);
        throw error;
      }
    } else {
      this.logger.info(`No file changes needed for ${path.basename(filename)}`);
    }
  }

  private findAllModelReferences(
    content: string,
    modelId: string
  ): Array<{ type: 'string' | 'constant'; value: string }> {
    const references: Array<{ type: 'string' | 'constant'; value: string }> = [];

    // Find direct string references
    const stringVariations = [`"${modelId}"`, `'${modelId}'`, `\`${modelId}\``];
    for (const variation of stringVariations) {
      if (content.includes(variation)) {
        references.push({ type: 'string', value: variation });
      }
    }

    // Find constant references
    const constantPattern = /(?:ChatModels|ImageModels)\.([A-Z_0-9]+)/g;
    const constants: string[] = [];
    let match;
    while ((match = constantPattern.exec(content)) !== null) {
      constants.push(match[0]);
    }

    // Map model ID to potential constants
    const potentialConstants = this.mapModelIdToConstants(modelId, constants);
    for (const constant of potentialConstants) {
      references.push({ type: 'constant', value: constant });
    }

    return references;
  }

  private mapModelIdToConstants(modelId: string, availableConstants: string[]): string[] {
    const matches: string[] = [];

    // Manual mappings for known problematic cases
    const manualMappings: Record<string, string[]> = {
      // Bedrock models
      'us.anthropic.claude-3-5-sonnet-20241022-v2:0': [
        'ChatModels.CLAUDE_3_5_SONNET_V2_BEDROCK',
        'ChatModels.CLAUDE_3_5_SONNET_BEDROCK',
        'ChatModels.CLAUDE_35_SONNET_V2_BEDROCK',
      ],
      'us.anthropic.claude-3-5-sonnet-20240620-v1:0': [
        'ChatModels.CLAUDE_3_5_SONNET_BEDROCK',
        'ChatModels.CLAUDE_35_SONNET_BEDROCK',
      ],
      'us.anthropic.claude-3-haiku-20240307-v1:0': [
        'ChatModels.CLAUDE_3_HAIKU_BEDROCK',
        'ChatModels.CLAUDE_HAIKU_BEDROCK',
      ],
      'us.anthropic.claude-3-opus-20240229-v1:0': [
        'ChatModels.CLAUDE_3_OPUS_BEDROCK',
        'ChatModels.CLAUDE_OPUS_BEDROCK',
      ],
      'meta.llama3-8b-instruct-v1:0': [
        'ChatModels.LLAMA3_INSTRUCT_8B_V1',
        'ChatModels.LLAMA3_8B_INSTRUCT_BEDROCK',
        'ChatModels.LLAMA3_8B_BEDROCK',
        'ChatModels.LLAMA_3_8B_BEDROCK',
      ],
      'meta.llama3-70b-instruct-v1:0': [
        'ChatModels.LLAMA3_INSTRUCT_70B_V1',
        'ChatModels.LLAMA3_70B_INSTRUCT_BEDROCK',
        'ChatModels.LLAMA3_70B_BEDROCK',
        'ChatModels.LLAMA_3_70B_BEDROCK',
      ],
      'amazon.titan-text-lite-v1': [
        'ChatModels.TITAN_TEXT_G1_LITE',
        'ChatModels.TITAN_TEXT_LITE_BEDROCK',
        'ChatModels.TITAN_LITE_BEDROCK',
        'ChatModels.AMAZON_TITAN_TEXT_LITE',
        'ChatModels.TITAN_TEXT_LITE',
        'ChatModels.TITAN_LITE',
      ],
      'amazon.titan-text-express-v1': [
        'ChatModels.TITAN_TEXT_G1_EXPRESS',
        'ChatModels.TITAN_TEXT_EXPRESS_BEDROCK',
        'ChatModels.TITAN_EXPRESS_BEDROCK',
        'ChatModels.AMAZON_TITAN_TEXT_EXPRESS',
        'ChatModels.TITAN_TEXT_EXPRESS',
        'ChatModels.TITAN_EXPRESS',
      ],
      // OpenAI models
      'gpt-4.1-nano-2025-04-14': ['ChatModels.GPT4_1_NANO', 'ChatModels.GPT4_NANO', 'ChatModels.GPT_4_1_NANO'],
      'gpt-4-turbo': ['ChatModels.GPT4_TURBO', 'ChatModels.GPT_4_TURBO'],
      'gpt-4': ['ChatModels.GPT4', 'ChatModels.GPT_4'],
      'o1-mini-2024-09-12': ['ChatModels.O1_MINI', 'ChatModels.O1MINI'],
      'o1-preview-2024-09-12': ['ChatModels.O1_PREVIEW', 'ChatModels.O1PREVIEW'],
      // Add more mappings as needed
    };

    // Check manual mappings first
    const manualMapping = manualMappings[modelId];
    if (manualMapping) {
      for (const mapping of manualMapping) {
        if (availableConstants.includes(mapping)) {
          matches.push(mapping);
        }
      }
    }

    // If no manual mapping found, try improved algorithmic mapping
    if (matches.length === 0) {
      console.log(`\n--- No manual mapping found for: ${modelId} ---`);
      console.log(`Available constants: ${availableConstants.join(', ')}`);

      // Extract key parts from model ID for better matching
      const modelParts = this.extractModelParts(modelId);
      console.log(`Extracted parts:`, modelParts);

      for (const constant of availableConstants) {
        const constantName = constant.split('.')[1]; // Get part after ChatModels./ImageModels.
        if (this.isAdvancedConstantMatch(modelParts, constantName)) {
          matches.push(constant);
          console.log(`✅ Matched via algorithmic approach: ${constant}`);
        }
      }
    }

    console.log(`Final matches for ${modelId}:`, matches);
    return matches;
  }

  private extractModelParts(modelId: string): {
    provider: string | null;
    model: string;
    version: string | null;
    variant: string | null;
    isPlatformSpecific: boolean;
  } {
    // Handle Bedrock format: us.anthropic.claude-3-5-sonnet-20241022-v2:0
    const bedrockMatch = modelId.match(/^us\.(\w+)\.(.+)-v\d+:\d+$/);
    if (bedrockMatch) {
      const [, provider, modelPart] = bedrockMatch;
      const versionMatch = modelPart.match(/-(\d{8})-?(.*)$/);
      const baseModel = versionMatch ? modelPart.replace(versionMatch[0], '') : modelPart;

      return {
        provider,
        model: baseModel,
        version: versionMatch ? versionMatch[1] : null,
        variant: versionMatch && versionMatch[2] ? versionMatch[2] : null,
        isPlatformSpecific: true,
      };
    }

    // Handle other AWS Bedrock format: amazon.titan-text-lite-v1
    const awsMatch = modelId.match(/^(\w+)\.(.+)-v\d+$/);
    if (awsMatch) {
      const [, provider, model] = awsMatch;
      return {
        provider,
        model,
        version: null,
        variant: null,
        isPlatformSpecific: true,
      };
    }

    // Handle standard format: gpt-4-turbo, o1-mini-2024-09-12
    const dateMatch = modelId.match(/^(.+)-(\d{4}-\d{2}-\d{2})$/);
    if (dateMatch) {
      const [, model, version] = dateMatch;
      return {
        provider: null,
        model,
        version,
        variant: null,
        isPlatformSpecific: false,
      };
    }

    // Default case
    return {
      provider: null,
      model: modelId,
      version: null,
      variant: null,
      isPlatformSpecific: false,
    };
  }

  private isAdvancedConstantMatch(
    modelParts: {
      provider: string | null;
      model: string;
      version: string | null;
      variant: string | null;
      isPlatformSpecific: boolean;
    },
    constantName: string
  ): boolean {
    const normalizedConstant = constantName.toLowerCase().replace(/_/g, '');

    // Build search terms from model parts
    const searchTerms: string[] = [];

    if (modelParts.provider) {
      searchTerms.push(modelParts.provider);
    }

    // Split model name and add parts
    const modelNameParts = modelParts.model
      .toLowerCase()
      .split(/[-.]/)
      .filter(part => part.length > 0);
    searchTerms.push(...modelNameParts);

    if (modelParts.variant) {
      searchTerms.push(modelParts.variant);
    }

    // Add platform suffix if applicable
    if (modelParts.isPlatformSpecific) {
      searchTerms.push('bedrock');
    }

    console.log(`Search terms for matching:`, searchTerms);
    console.log(`Normalized constant:`, normalizedConstant);

    // Check if most important terms are present
    let matchCount = 0;
    let totalImportantTerms = 0;

    for (const term of searchTerms) {
      const normalizedTerm = term.toLowerCase();

      // Skip very common or less important terms
      if (['v1', 'v2', 'instruct', 'text'].includes(normalizedTerm)) {
        continue;
      }

      totalImportantTerms++;

      if (normalizedConstant.includes(normalizedTerm)) {
        matchCount++;
        console.log(`✅ Found term "${normalizedTerm}" in constant`);
      }
    }

    // Require at least 60% of important terms to match
    const matchRatio = totalImportantTerms > 0 ? matchCount / totalImportantTerms : 0;
    console.log(`Match ratio: ${matchCount}/${totalImportantTerms} = ${matchRatio}`);

    return matchRatio >= 0.6 && matchCount >= 2;
  }

  private normalizeModelId(modelId: string): string {
    return modelId
      .toLowerCase()
      .replace(/[.-]/g, '')
      .replace(/\d{4}-\d{2}-\d{2}/, '') // Remove dates
      .replace(/v\d+$/, '') // Remove version suffixes
      .replace(/:\d+$/, '') // Remove :0 suffixes
      .replace(/^(us\.|meta\.|amazon\.)/, '') // Remove provider prefixes
      .trim();
  }

  private normalizeConstantName(constantName: string): string {
    return constantName
      .toLowerCase()
      .replace(/_/g, '')
      .replace(/bedrock$/, '') // Remove bedrock suffix
      .replace(/v\d+$/, '') // Remove version suffixes
      .trim();
  }

  private isConstantMatch(normalizedModelId: string, normalizedConstant: string): boolean {
    // Direct match
    if (normalizedModelId === normalizedConstant) {
      return true;
    }

    // Substring matches (both directions)
    if (normalizedModelId.length > 4 && normalizedConstant.includes(normalizedModelId)) {
      return true;
    }

    if (normalizedConstant.length > 4 && normalizedModelId.includes(normalizedConstant)) {
      return true;
    }

    // Special case for numbered models
    const modelIdNumbers = normalizedModelId.match(/\d+/g) || [];
    const constantNumbers = normalizedConstant.match(/\d+/g) || [];

    if (modelIdNumbers.length > 0 && constantNumbers.length > 0) {
      const modelIdWithoutNumbers = normalizedModelId.replace(/\d+/g, '');
      const constantWithoutNumbers = normalizedConstant.replace(/\d+/g, '');

      return (
        modelIdWithoutNumbers === constantWithoutNumbers &&
        JSON.stringify(modelIdNumbers) === JSON.stringify(constantNumbers)
      );
    }

    return false;
  }

  private async debugModelSearch(content: string, modelId: string): Promise<void> {
    console.log(`Looking for model ID: ${modelId}`);

    // Show all ChatModels and ImageModels constants in the file
    const constantMatches = content.match(/(ChatModels|ImageModels)\.[A-Z_0-9]+/g) || [];
    const uniqueConstants = [...new Set(constantMatches)];
    console.log(`\nAvailable constants in file (${uniqueConstants.length}):`);
    uniqueConstants.forEach((constant, i) => {
      console.log(`  ${i + 1}. ${constant}`);
    });

    // Show potential matches based on our mapping
    console.log(`\nPotential matches for "${modelId}":`);
    const potentialMatches = this.mapModelIdToConstants(modelId, uniqueConstants);
    if (potentialMatches.length > 0) {
      potentialMatches.forEach((match, i) => {
        console.log(`  ${i + 1}. ${match}`);

        // Show context around this constant
        const index = content.indexOf(match);
        if (index !== -1) {
          const start = Math.max(0, index - 100);
          const end = Math.min(content.length, index + 300);
          const context = content.substring(start, end);
          console.log(`     Context: ...${context}...`);
        }
      });
    } else {
      console.log(`  No potential matches found`);
    }

    // Extract and show the model parts for debugging
    const modelParts = this.extractModelParts(modelId);
    console.log(`\nExtracted model parts:`, modelParts);
  }

  private escapeDescription(description: string): string {
    return description
      .replace(/\\/g, '\\\\') // Escape backslashes first
      .replace(/"/g, '\\"') // Escape double quotes
      .replace(/'/g, "\\'") // Escape single quotes
      .replace(/`/g, '\\`') // Escape backticks
      .replace(/\n/g, '\\n') // Escape newlines
      .replace(/\r/g, '\\r'); // Escape carriage returns
  }

  private isValidUpdateResult(obj: unknown): obj is { descriptions: ModelDescriptions; reasons: ModelUpdateReasons } {
    if (!obj || typeof obj !== 'object') {
      return false;
    }

    const result = obj as any;

    // Check if descriptions and reasons properties exist and are objects
    if (!result.descriptions || typeof result.descriptions !== 'object') {
      return false;
    }

    if (!result.reasons || typeof result.reasons !== 'object') {
      return false;
    }

    // Validate that all values are strings (less strict about keys)
    const descriptionsValid = Object.entries(result.descriptions).every(
      ([key, value]) => typeof key === 'string' && typeof value === 'string'
    );

    const reasonsValid = Object.entries(result.reasons).every(
      ([key, value]) => typeof key === 'string' && typeof value === 'string'
    );

    // Also check that every description has a corresponding reason
    const descriptionsKeys = Object.keys(result.descriptions);
    const reasonsKeys = Object.keys(result.reasons);
    const keysMatch =
      descriptionsKeys.every(key => reasonsKeys.includes(key)) &&
      reasonsKeys.every(key => descriptionsKeys.includes(key));

    return descriptionsValid && reasonsValid && keysMatch;
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private async getUpdatedDescriptions(models: readonly ModelInfo[]): Promise<UpdateResult> {
    // Process models in batches of 5 to avoid response length issues
    const batchSize = 5;
    const descriptions: ModelDescriptions = {} as ModelDescriptions;
    const reasons: ModelUpdateReasons = {} as ModelUpdateReasons;

    for (let i = 0; i < models.length; i += batchSize) {
      const batch = models.slice(i, i + batchSize).filter(model => model.type === 'text');
      const modelMetadata: ModelInfoRequest = {
        models: batch.map(model => ({
          id: model.id as ModelName,
          name: model.name,
          type: model.type as 'text',
          contextWindow: model.contextWindow,
          maxTokens: model.max_tokens,
          supportsVision: model.supportsVision,
          supportsTools: model.supportsTools,
          supportsImageVariation: model.supportsImageVariation,
          trainingCutoff: model.trainingCutoff,
          currentDescription: model.description,
        })),
      };

      const prompt = `As an AI expert, analyze these AI models' descriptions and identify ONLY those that need updates. For each model that needs updating, provide both a new description and the specific reason why it needs to be updated.
    
      Focus on identifying outdated information such as:
      1. Outdated cost efficiency claims (if another model is now more cost-efficient, specify which one)
      2. Deprecated features or capabilities
      3. Inaccurate technical specifications
      4. Missing important new features
      5. Training cutoff dates that affect relevance
      6. Performance claims that are no longer accurate
      
      For each model, consider:
      - Its current description accuracy
      - Cost efficiency compared to other models
      - Context window size and token limits
      - Special features (tools, image generation, etc.)
      - Training cutoff date relevance
      - Current market position
      
      Here are the models to analyze:
      
      ${JSON.stringify(modelMetadata, null, 2)}
      
      DESCRIPTION WRITING GUIDELINES:
      - Write descriptions as standalone, positive statements about what the model IS good for
      - Avoid comparative language like "but", "however", "although", "while"
      - Focus on the model's current strengths and appropriate use cases
      - Do NOT mention what other models do better
      - Use present tense and active voice
      - Be specific about capabilities without unnecessary hedging
      - Frame limitations as target use cases rather than shortcomings
      
      GOOD: "Specialized for lightweight text processing and basic content generation tasks."
      BAD: "Good for basic tasks, but newer models offer better capabilities."
      
      GOOD: "Optimized for cost-sensitive applications requiring moderate reasoning capabilities."
      BAD: "Cost-effective choice, but less capable than premium models."
      
      Return a JSON object with two properties:
      1. "descriptions": mapping of model IDs that need updates to their new descriptions
      2. "reasons": mapping of model IDs to specific reasons why they need updates
      
      Format example:
      {
        "descriptions": {
          "model-id-that-needs-update": "Updated accurate description"
        },
        "reasons": {
          "model-id-that-needs-update": "Specific reason: e.g., 'Claims to be most cost-efficient but GPT-4o-mini is now more cost-effective for similar tasks'"
        }
      }
      
      Requirements:
      1. ONLY include models that genuinely need updates
      2. Provide specific, factual reasons for each update
      3. If claiming a model is no longer most cost-efficient, specify which model is now better
      4. Be precise about what information is outdated or incorrect
      5. Keep descriptions under 200 characters and grammatically correct
      6. Write descriptions as positive, standalone statements without comparative language
      7. Return ONLY the JSON object, no markdown formatting or extra text
      8. If no models need updates, return empty objects for both properties
      
      IMPORTANT: Return ONLY the JSON object with no markdown formatting, code blocks, or extra text.`;

      const llmModel = this.modelId as ModelName;
      const apiKeyTable = this.buildApiKeyTable();
      const availableModels = await getAvailableModels(apiKeyTable);
      const selectedModel = availableModels.find(model => model.id === llmModel);
      if (!selectedModel) {
        throw new Error(`Model ${llmModel} not found in available models`);
      }

      const llm = getLlmByModel(apiKeyTable, {
        modelInfo: selectedModel,
        logger: this.logger,
      });
      if (!llm) {
        throw new Error(`No LLM instance created for model ${selectedModel.id}`);
      }

      let response = '';
      const streamHandler: CompletionStreamHandler = async streamedText => {
        for (const message of streamedText) {
          if (typeof message === 'string') {
            response += message;
          }
        }
      };

      try {
        await llm.complete(
          selectedModel.id,
          [
            {
              role: 'user',
              content: prompt,
            },
          ],
          {
            maxTokens: 3000,
            temperature: 0.1,
          },
          streamHandler
        );
      } catch (error) {
        this.logger.error('LLM completion failed:', error);
        throw error;
      }

      try {
        const cleanedResponse = response.replace(/```json\n|\n```/g, '').trim();
        const jsonMatch = cleanedResponse.match(/\{[\s\S]*\}/);
        const jsonString = jsonMatch ? jsonMatch[0] : cleanedResponse;

        const parsedResponse = JSON.parse(jsonString);

        if (!this.isValidUpdateResult(parsedResponse)) {
          throw new Error('Invalid response format from LLM');
        }

        // Merge batch results
        Object.assign(descriptions, parsedResponse.descriptions || {});
        Object.assign(reasons, parsedResponse.reasons || {});

        // Log progress
        this.logger.info(`Analyzed batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(models.length / batchSize)}`);
      } catch (error) {
        this.logger.error('Failed to parse LLM response:', response);
        throw new Error(`JSON parsing failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return { descriptions, reasons };
  }

  private buildApiKeyTable(): ApiKeyTable {
    // Determine which API key field to use based on model ID patterns
    if (this.modelId.includes('gpt') || this.modelId.includes('o1')) {
      return { openai: this.apiKey };
    } else if (this.modelId.includes('claude')) {
      return { anthropic: this.apiKey };
    } else if (this.modelId.includes('gemini')) {
      return { gemini: this.apiKey };
    } else if (this.modelId.includes('llama') || this.modelId.includes('ollama')) {
      return { ollama: this.apiKey };
    } else if (this.modelId.includes('bfl')) {
      return { bfl: this.apiKey };
    } else if (this.modelId.includes('grok') || this.modelId.includes('xai')) {
      return { xai: this.apiKey };
    } else {
      // Default to openai for backward compatibility
      return { openai: this.apiKey };
    }
  }
}

if (import.meta.url === import.meta.resolve('./syncModelDescriptions.ts')) {
  const apiKey = process.env.API_KEY;
  const modelId = process.env.MODEL_ID;

  if (!apiKey) {
    console.error('API_KEY environment variable is required');
    process.exit(1);
  }

  if (!modelId) {
    console.error('MODEL_ID environment variable is required');
    process.exit(1);
  }

  void new SyncModelDescriptions(apiKey, modelId)
    .run()
    .then(exitCode => {
      console.log(`Script completed with exit code: ${exitCode}`);
      process.exit(exitCode);
    })
    .catch(err => {
      console.error('Error syncing model descriptions:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
