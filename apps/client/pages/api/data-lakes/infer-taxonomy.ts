import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { rateLimit } from '@server/middlewares/rateLimit';
import { isDevelopment } from '@server/utils/config';
import { InferTaxonomyRequestInput, InferTaxonomyResponse, hasDeveloperUserTag } from '@bike4mind/common';
import { apiKeyService } from '@bike4mind/services';
import { ApiKeyType } from '@bike4mind/common';
import { apiKeyRepository, adminSettingsRepository } from '@bike4mind/database';
import OpenAI from 'openai';
import { Request } from 'express';

// Per-user/day cap on taxonomy inference. The endpoint is tag-gated (admin / opti /
// developer), but a tagged user could otherwise burn OpenAI spend unbounded. Admins and
// developer-tagged users stay uncapped; every other caller who reaches here gets the daily
// cap. The limit trips in middleware, before any OpenAI call, so a rejected request is free.
export const TAXONOMY_INFERENCE_DAILY_CAP = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

export const resolveTaxonomyDailyLimit = (req: Request): number => {
  if (isDevelopment()) return Infinity;
  if (req.user?.isAdmin || hasDeveloperUserTag(req.user?.tags)) return Infinity;
  return TAXONOMY_INFERENCE_DAILY_CAP;
};

/**
 * Taxonomy inference is OPTIONAL and non-blocking: on any failure (no key, no/blank
 * response, unparseable or malformed JSON) we return an empty taxonomy with HTTP 200
 * rather than erroring, so the upload flow is never blocked. Files still get basic
 * tags (MIME, top-level folder, the meta-tag) without an inferred taxonomy.
 */
const emptyTaxonomy = (existingPrefix?: string): InferTaxonomyResponse => ({
  suggestedPrefix: existingPrefix ?? '',
  suggestedName: '',
  categories: [],
  fileAssignments: [],
});

const SYSTEM_PROMPT = `You are a data organization expert. Given a folder tree with file names, sizes, and optional content samples, suggest a tag taxonomy for organizing these files into a searchable knowledge base.

Your response must be valid JSON with this exact structure:
{
  "suggestedPrefix": "acme:",
  "suggestedName": "Acme Corp Knowledge Base",
  "categories": [
    {
      "tagName": "acme:type:contract",
      "description": "Legal contracts and agreements",
      "confidence": 0.95,
      "matchingFolders": ["contracts", "legal/agreements"]
    }
  ],
  "fileAssignments": [
    {
      "relativePath": "contracts/2024/vendor-agreement.pdf",
      "suggestedTags": [
        { "name": "acme:type:contract", "strength": 0.9 },
        { "name": "acme:year:2024", "strength": 1.0 }
      ]
    }
  ]
}

Guidelines:
- The prefix should be short (2-8 chars), lowercase, derived from the apparent domain/company
- Tag names use colon-separated hierarchies: prefix:dimension:value (e.g. "acme:type:report", "acme:topic:finance")
- Common dimensions: type, topic, department, year, status, audience
- Confidence scores: 0.90-1.0 for clear patterns, 0.75-0.89 for likely patterns, 0.70-0.74 for speculative
- Strength scores for file assignments: 0.7-1.0 based on how well the file matches the tag
- Group related concepts (don't create too many tags — aim for 5-20 categories)
- Use folder structure as a strong signal for taxonomy
- If content samples are provided, use them to improve tag accuracy
- Assign 1-3 tags per file in fileAssignments (only include sampled files)`;

const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .use(rateLimit({ limit: resolveTaxonomyDailyLimit, windowMs: DAY_MS, bucket: 'data-lakes/infer-taxonomy' }))
  .post(async (req: Request, res) => {
    // Access control: require admin, developer, or opti tag (matches other data lake endpoints)
    const userTags: string[] = req.user.tags ?? [];
    const normalizedTags = userTags.map(t => t.toLowerCase());
    const hasAccess =
      req.user.isAdmin || normalizedTags.some(t => ['opti', 'developer', 'developers', 'dev'].includes(t));

    if (!hasAccess) {
      return res.status(403).json({ error: 'Data lake access required' });
    }

    const userId = req.user.id;
    const data = InferTaxonomyRequestInput.parse(req.body);

    const openaiApiKey = await apiKeyService.getEffectiveApiKey(
      userId,
      { type: ApiKeyType.openai, nullIfMissing: true },
      { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository } }
    );

    if (!openaiApiKey) {
      // Non-blocking: no key configured -> no inferred taxonomy.
      return res.json(emptyTaxonomy(data.existingPrefix));
    }

    const openai = new OpenAI({ apiKey: openaiApiKey });

    // Build the user prompt from the folder tree
    const folderStructure = data.folderTree
      .map(entry => {
        let line = `${entry.relativePath} (${formatSize(entry.fileSize)}`;
        if (entry.mimeType) line += `, ${entry.mimeType}`;
        line += ')';
        if (entry.contentSample) {
          line += `\n  Content preview: "${entry.contentSample.slice(0, 200)}"`;
        }
        return line;
      })
      .join('\n');

    let userPrompt = `Analyze this folder structure and suggest a tag taxonomy:\n\n${folderStructure}`;

    if (data.existingPrefix) {
      userPrompt += `\n\nThe user has an existing tag prefix: "${data.existingPrefix}". Use this prefix for all tags.`;
    }

    if (data.context) {
      userPrompt += `\n\nAdditional context from the user: "${data.context}"`;
    }

    userPrompt += `\n\nTotal files in folder tree sample: ${data.folderTree.length}`;

    let parsed: InferTaxonomyResponse;
    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 4000,
      });

      const rawContent = completion.choices[0]?.message?.content;
      if (!rawContent) {
        return res.json(emptyTaxonomy(data.existingPrefix));
      }

      parsed = JSON.parse(rawContent);

      // Validate structure minimally - degrade to empty rather than failing the upload.
      if (!parsed.suggestedPrefix || !parsed.categories || !Array.isArray(parsed.categories)) {
        return res.json(emptyTaxonomy(data.existingPrefix));
      }
    } catch (error) {
      console.warn('Taxonomy inference failed; returning empty taxonomy (non-blocking):', error);
      return res.json(emptyTaxonomy(data.existingPrefix));
    }

    // Ensure prefix ends with ':'
    if (!parsed.suggestedPrefix.endsWith(':')) {
      parsed.suggestedPrefix += ':';
    }

    return res.json(parsed);
  });

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
