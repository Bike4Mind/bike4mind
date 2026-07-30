import type { IFabFileDocument, InferTaxonomyResponse } from '@bike4mind/common';
import OpenAI from 'openai';

/**
 * One sampled file, enough signal for the model to infer a taxonomy from: path/name/size/type
 * plus an optional short text preview. Shared shape between the (removed) pre-upload client
 * sampler and the post-upload background job, which rebuilds this from persisted
 * FabFile records instead of in-browser File objects.
 */
export interface TaxonomyFolderEntry {
  relativePath: string;
  fileName: string;
  fileSize: number;
  mimeType?: string;
  contentSample?: string;
}

/** Taxonomy inference is OPTIONAL and non-blocking: on any failure this returns an empty
 * result rather than throwing, so a caller can always proceed with folder-only tags. */
export const emptyTaxonomyResponse = (existingPrefix?: string): InferTaxonomyResponse => ({
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
- Group related concepts (don't create too many tags - aim for 5-20 categories)
- Use folder structure as a strong signal for taxonomy
- If content samples are provided, use them to improve tag accuracy
- Assign 1-3 tags per file in fileAssignments (only include sampled files)`;

/**
 * Sample already-uploaded FabFiles into the folder-tree shape the inference prompt wants:
 * up to `maxPerFolder` per folder, `maxTotal` overall, so a huge ingest doesn't blow the
 * prompt budget. Mirrors the client wizard's old, now-removed stratified sampleFiles, now
 * server-side since files are analyzed post-upload. Shared by the automatic post-upload job
 * and the manual re-analyze endpoint so both sample identically.
 */
export function sampleFabFilesForTaxonomy(
  files: IFabFileDocument[],
  maxPerFolder = 5,
  maxTotal = 50
): TaxonomyFolderEntry[] {
  const byFolder = new Map<string, IFabFileDocument[]>();
  for (const f of files) {
    const parts = (f.relativePath ?? f.fileName).split('/');
    const folderPath = parts.slice(0, -1).join('/') || '/';
    const group = byFolder.get(folderPath) || [];
    group.push(f);
    byFolder.set(folderPath, group);
  }

  const sampled: IFabFileDocument[] = [];
  for (const [, group] of byFolder) {
    sampled.push(...group.slice(0, maxPerFolder));
    if (sampled.length >= maxTotal) break;
  }

  return sampled.slice(0, maxTotal).map(f => ({
    relativePath: f.relativePath ?? f.fileName,
    fileName: f.fileName,
    fileSize: f.fileSize ?? 0,
    mimeType: f.mimeType,
  }));
}

const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
};

/**
 * Call the LLM to infer a tag taxonomy from a sampled folder tree. Never throws - every
 * failure mode (blank/unparseable/malformed response) degrades to `emptyTaxonomyResponse`
 * so a caller can always proceed with folder-only tags. The caller resolves/owns the API
 * key (both the auto post-upload job and a manual re-analyze share this one call site).
 */
export async function runTaxonomyInference(
  openaiApiKey: string,
  folderTree: TaxonomyFolderEntry[],
  options?: { existingPrefix?: string; context?: string }
): Promise<InferTaxonomyResponse> {
  const openai = new OpenAI({ apiKey: openaiApiKey });

  const folderStructure = folderTree
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

  if (options?.existingPrefix) {
    userPrompt += `\n\nThe user has an existing tag prefix: "${options.existingPrefix}". Use this prefix for all tags.`;
  }

  if (options?.context) {
    userPrompt += `\n\nAdditional context from the user: "${options.context}"`;
  }

  userPrompt += `\n\nTotal files in folder tree sample: ${folderTree.length}`;

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
    if (!rawContent) return emptyTaxonomyResponse(options?.existingPrefix);

    const parsed = JSON.parse(rawContent) as InferTaxonomyResponse;

    // Validate structure minimally - degrade to empty rather than failing the caller.
    if (!parsed.suggestedPrefix || !parsed.categories || !Array.isArray(parsed.categories)) {
      return emptyTaxonomyResponse(options?.existingPrefix);
    }

    if (!parsed.suggestedPrefix.endsWith(':')) {
      parsed.suggestedPrefix += ':';
    }

    return parsed;
  } catch (error) {
    console.warn('Taxonomy inference failed; returning empty taxonomy (non-blocking):', error);
    return emptyTaxonomyResponse(options?.existingPrefix);
  }
}
