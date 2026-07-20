import { ExtractedArtifact, CurationArtifactType as ArtifactType } from '@bike4mind/common';

/**
 * LLM-powered "Executive Summary" markdown generator for curated notebooks (Option 2).
 * Produces AI-generated insights, decisions, and artifact descriptions. More expensive
 * than the raw transcript (requires LLM calls) but better for knowledge sharing.
 */

export interface LLMMarkdownGeneratorOptions {
  includeTimestamps: boolean;
  includeMetadata: boolean;
  includeTableOfContents: boolean;
}

const DEFAULT_OPTIONS: LLMMarkdownGeneratorOptions = {
  includeTimestamps: false, // Executive summaries don't need timestamps
  includeMetadata: true,
  includeTableOfContents: true,
};

/**
 * LLM Context interface (matches ToolContext pattern from deepResearch)
 */
export interface LLMContext {
  complete: (
    model: string,
    messages: Array<{ role: string; content: string }>,
    options: { temperature: number; stream: boolean },
    callback: (chunks: string[]) => Promise<void>
  ) => Promise<void>;
}

/** Per-curation token usage, split so savings are measurable (issue #91 AC#1). */
export interface CurationTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * Generates text from the LLM and reports the input/output token split for that
 * call. The streaming complete() interface does not surface real provider usage,
 * so counts are estimated (chars/4); keeping input and output separate is what
 * makes the before/after comparison meaningful.
 */
type GenerateTextFn = (prompt: string) => Promise<{ text: string; inputTokens: number; outputTokens: number }>;

// Delimiters for the single consolidated narrative call. The model emits all
// three sections in one response; we split them back apart by these markers.
export const SUMMARY_DELIMITER = '===EXECUTIVE_SUMMARY===';
export const INSIGHTS_DELIMITER = '===KEY_INSIGHTS===';
export const DECISIONS_DELIMITER = '===DECISIONS_AND_ACTIONS===';

/**
 * Generate Option 2: LLM-powered executive summary
 *
 * AI analyzes the conversation and generates:
 * - Executive Summary
 * - Key Insights
 * - Decisions Made
 * - Action Items
 * - Code & Artifacts (with AI-generated descriptions)
 * - Learnings & Takeaways
 *
 * The summary, insights and decisions come from a SINGLE LLM call that sends the
 * conversation sample once (previously three calls each re-embedded the same
 * ~5000-char sample). Artifact descriptions remain a separate batched call.
 */
export async function generateExecutiveSummaryMarkdown(
  session: any,
  messages: any[],
  artifacts: ExtractedArtifact[],
  llmContext: LLMContext,
  model: string,
  options: Partial<LLMMarkdownGeneratorOptions> = {}
): Promise<{ markdown: string; tokensUsed: number; tokenUsage: CurationTokenUsage }> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const sections: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;

  const generateText: GenerateTextFn = async (prompt: string) => {
    let result = '';
    await llmContext.complete(
      model,
      [{ role: 'user', content: prompt }],
      { temperature: 0.7, stream: false },
      async chunks => {
        result += chunks[0] || '';
      }
    );
    return { text: result, inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(result) };
  };

  // Header
  sections.push(generateExecutiveHeader(session, messages, artifacts));

  // Table of Contents
  if (opts.includeTableOfContents) {
    sections.push(generateExecutiveTOC());
  }

  // Single consolidated call: summary + insights + decisions from one sample.
  // Skip any section the model left empty (e.g. the no-delimiter fallback puts
  // everything in summary) rather than emit a bare heading.
  const narrative = await generateAIConsolidatedNarrative(session, messages, generateText);
  if (narrative.summary) sections.push(`## Executive Summary\n\n${narrative.summary}`);
  if (narrative.insights) sections.push(`## Key Insights\n\n${narrative.insights}`);
  if (narrative.decisions) sections.push(`## Decisions & Actions\n\n${narrative.decisions}`);
  inputTokens += narrative.inputTokens;
  outputTokens += narrative.outputTokens;

  // Code & Artifacts (with AI-generated descriptions)
  if (artifacts.length > 0) {
    const artifactsResult = await generateAIArtifactsSection(artifacts, messages, generateText);
    sections.push(artifactsResult.markdown);
    inputTokens += artifactsResult.inputTokens;
    outputTokens += artifactsResult.outputTokens;
  }

  const totalTokens = inputTokens + outputTokens;

  // Metadata Footer
  if (opts.includeMetadata) {
    sections.push(generateExecutiveMetadata(session, messages, artifacts, totalTokens));
  }

  return {
    markdown: sections.filter(Boolean).join('\n\n---\n\n'),
    tokensUsed: totalTokens,
    tokenUsage: { inputTokens, outputTokens, totalTokens },
  };
}

/**
 * Generate executive-style header
 */
function generateExecutiveHeader(session: any, messages: any[], artifacts: ExtractedArtifact[]): string {
  const created = session.firstCreated ? new Date(session.firstCreated).toLocaleDateString() : 'Unknown';
  const updated = session.lastUpdated ? new Date(session.lastUpdated).toLocaleDateString() : 'Unknown';

  return `# ${session.name}

**Executive Summary (AI-Curated)**

- **Created:** ${created}
- **Last Updated:** ${updated}
- **Conversation Turns:** ${messages.length}
- **Artifacts Generated:** ${artifacts.length}
- **Document Type:** AI-Generated Executive Summary`;
}

/**
 * Generate executive-style table of contents
 */
function generateExecutiveTOC(): string {
  return `## Table of Contents

- [Executive Summary](#executive-summary)
- [Key Insights](#key-insights)
- [Decisions & Actions](#decisions--actions)
- [Code & Artifacts](#code--artifacts)
- [Metadata](#metadata)`;
}

/**
 * Generate the executive summary, key insights, and decisions/actions in a
 * SINGLE LLM call. Previously three separate calls each re-embedded the same
 * ~5000-char conversation sample, paying for that context three times (issue
 * #91). Here the sample is sent once and the model returns three delimited
 * sections, which parseConsolidatedNarrative splits back apart.
 */
async function generateAIConsolidatedNarrative(
  session: any,
  messages: any[],
  generateText: GenerateTextFn
): Promise<{ summary: string; insights: string; decisions: string; inputTokens: number; outputTokens: number }> {
  const conversationSample = sampleConversation(messages, 5000); // ~5000 chars max

  const prompt = `You are curating a notebook conversation into an executive summary for knowledge sharing.

Session: ${session.name}
Total Messages: ${messages.length}

Conversation Sample:
${conversationSample}

Produce THREE sections. Introduce each with its exact delimiter line below, on its own line, and add no other top-level headings.

${SUMMARY_DELIMITER}
A comprehensive executive summary: explain what the conversation was about (1-2 paragraphs), highlight the main topics discussed, and describe the outcome or final state. Professional, concise style.

${INSIGHTS_DELIMITER}
The top 5-7 key insights or learnings as a bullet list. Each bullet concise (1-2 sentences), actionable or informative, focused on technical or strategic learnings. Example:
- **Understanding of X**: Brief explanation
- **Decision on Y**: What was decided and why

${DECISIONS_DELIMITER}
Two markdown subsections:
### Decisions Made
List 3-5 major decisions with brief rationale.
### Action Items
List any next steps or TODOs mentioned.`;

  const { text, inputTokens, outputTokens } = await generateText(prompt);
  const parsed = parseConsolidatedNarrative(text);

  return { ...parsed, inputTokens, outputTokens };
}

/**
 * Split the consolidated response into its three sections by delimiter. Tolerant
 * by design: if the model omits the delimiters entirely, the whole response
 * falls back into the summary so no content is lost. Sections are emitted in a
 * fixed order (summary -> insights -> decisions); each ends at the next present
 * delimiter.
 */
export function parseConsolidatedNarrative(text: string): { summary: string; insights: string; decisions: string } {
  // Match a delimiter only when it is alone on its own line, so a delimiter
  // string echoed inside a section body cannot split the response wrongly.
  // The delimiters contain no regex-special characters.
  const findDelim = (delim: string): number => {
    const match = new RegExp(`^${delim}[ \\t]*$`, 'm').exec(text);
    return match ? match.index : -1;
  };

  const summaryIdx = findDelim(SUMMARY_DELIMITER);
  const insightsIdx = findDelim(INSIGHTS_DELIMITER);
  const decisionsIdx = findDelim(DECISIONS_DELIMITER);

  if (summaryIdx === -1 && insightsIdx === -1 && decisionsIdx === -1) {
    return { summary: text.trim(), insights: '', decisions: '' };
  }

  const slice = (start: number, delim: string, end: number): string => {
    if (start === -1) return '';
    return text.slice(start + delim.length, end === -1 ? text.length : end).trim();
  };

  const summary = slice(summaryIdx, SUMMARY_DELIMITER, insightsIdx !== -1 ? insightsIdx : decisionsIdx);
  const insights = slice(insightsIdx, INSIGHTS_DELIMITER, decisionsIdx);
  const decisions = slice(decisionsIdx, DECISIONS_DELIMITER, -1);

  return { summary, insights, decisions };
}

/**
 * Generate AI-powered artifacts section with descriptions
 * OPTIMIZED: Batches all artifact descriptions into a single LLM call
 */
async function generateAIArtifactsSection(
  artifacts: ExtractedArtifact[],
  messages: any[],
  generateText: GenerateTextFn
): Promise<{ markdown: string; inputTokens: number; outputTokens: number }> {
  const sections: string[] = ['## Code & Artifacts\n'];

  // Group artifacts by type
  const typeGroups = groupArtifactsByType(artifacts);

  // Sort by priority
  const typePriority: Record<string, number> = {
    [ArtifactType.CODE]: 1,
    [ArtifactType.REACT]: 2,
    [ArtifactType.HTML]: 3,
    [ArtifactType.MERMAID]: 4,
    [ArtifactType.RECHARTS]: 5,
    [ArtifactType.SVG]: 6,
    [ArtifactType.QUESTMASTER_PLAN]: 7,
    [ArtifactType.DEEP_RESEARCH]: 8,
    [ArtifactType.IMAGE]: 9,
  };

  const sortedTypes = Object.keys(typeGroups).sort((a, b) => (typePriority[a] || 99) - (typePriority[b] || 99));

  // OPTIMIZATION: Generate all artifact descriptions in a single batched LLM call
  const batchDescriptionResult = await generateBatchedArtifactDescriptions(artifacts, messages, generateText);

  // Create a map of artifact index to description for quick lookup
  const descriptionMap = new Map<number, string>();
  artifacts.forEach((artifact, index) => {
    descriptionMap.set(index, batchDescriptionResult.descriptions[index] || 'No description available.');
  });

  // Build markdown sections with pre-generated descriptions
  let globalArtifactIndex = 0;
  for (const type of sortedTypes) {
    const artifactType = type as ArtifactType;
    const typeArtifacts = typeGroups[type];
    const typeLabel = formatArtifactTypeLabel(artifactType);

    sections.push(`### ${typeLabel}\n`);

    for (let i = 0; i < typeArtifacts.length; i++) {
      const artifact = typeArtifacts[i];
      const description = descriptionMap.get(globalArtifactIndex) || 'No description available.';

      sections.push(formatArtifactWithDescription(artifact, i + 1, description));
      globalArtifactIndex++;
    }
  }

  return {
    markdown: sections.join('\n'),
    inputTokens: batchDescriptionResult.inputTokens,
    outputTokens: batchDescriptionResult.outputTokens,
  };
}

/**
 * Generate AI descriptions for all artifacts in a single batched LLM call
 * OPTIMIZATION: Reduces N LLM calls to 1 LLM call, saving significant tokens and cost
 */
async function generateBatchedArtifactDescriptions(
  artifacts: ExtractedArtifact[],
  messages: any[],
  generateText: GenerateTextFn
): Promise<{ descriptions: string[]; inputTokens: number; outputTokens: number }> {
  // If no artifacts, return empty
  if (artifacts.length === 0) {
    return { descriptions: [], inputTokens: 0, outputTokens: 0 };
  }

  // Build a single prompt with all artifacts
  const artifactPrompts = artifacts.map((artifact, index) => {
    const contextMessages = findArtifactContext(artifact, messages);

    return `[ARTIFACT ${index + 1}]
Type: ${artifact.type}${artifact.language ? ` | Language: ${artifact.language}` : ''}
Code Preview:
${artifact.content.substring(0, 400)}${artifact.content.length > 400 ? '...' : ''}

Context: ${contextMessages}
`;
  });

  const batchPrompt = `You are analyzing artifacts from a technical conversation. For each artifact below, provide a concise 1-2 sentence description explaining what it does and why it's relevant.

${artifactPrompts.join('\n---\n')}

Format your response as a numbered list matching the artifact numbers above. Each description should be:
- Concise (1-2 sentences maximum)
- Technical and specific
- Focused on the purpose and functionality

Example format:
1. [Description for artifact 1]
2. [Description for artifact 2]
3. [Description for artifact 3]

Provide descriptions for all ${artifacts.length} artifacts:`;

  const { text, inputTokens, outputTokens } = await generateText(batchPrompt);

  // Parse the numbered list response into individual descriptions
  const descriptions = parseNumberedListResponse(text, artifacts.length);

  return {
    descriptions,
    inputTokens,
    outputTokens,
  };
}

/**
 * Parse a numbered list response from LLM into individual items
 */
function parseNumberedListResponse(text: string, expectedCount: number): string[] {
  const lines = text.split('\n').filter(line => line.trim());
  const descriptions: string[] = [];

  for (const line of lines) {
    // Match patterns like "1.", "1)", "[1]", etc.
    const match = line.match(/^\s*[\[\(]?\d+[\.\)\]]\s*(.+)$/);
    if (match && match[1]) {
      descriptions.push(match[1].trim());
    }
  }

  // If parsing failed or we got fewer descriptions than expected, pad with defaults
  while (descriptions.length < expectedCount) {
    descriptions.push('Code artifact for technical implementation.');
  }

  // Truncate if we got more than expected (shouldn't happen but just in case)
  return descriptions.slice(0, expectedCount);
}

/**
 * Format artifact with AI-generated description
 */
function formatArtifactWithDescription(artifact: ExtractedArtifact, index: number, description: string): string {
  const title = artifact.metadata?.title || `${formatArtifactTypeLabel(artifact.type)} #${index}`;

  let formattedArtifact = `#### ${index}. ${title}\n\n`;
  formattedArtifact += `*${description}*\n\n`;

  switch (artifact.type) {
    case ArtifactType.CODE:
    case ArtifactType.REACT:
    case ArtifactType.HTML:
      formattedArtifact += `\`\`\`${artifact.language || 'text'}\n${artifact.content}\n\`\`\``;
      break;

    case ArtifactType.MERMAID:
      formattedArtifact += `\`\`\`mermaid\n${artifact.content}\n\`\`\``;
      break;

    case ArtifactType.RECHARTS:
      formattedArtifact += `\`\`\`json\n${artifact.content}\n\`\`\``;
      break;

    case ArtifactType.SVG:
      formattedArtifact += `\`\`\`svg\n${artifact.content}\n\`\`\``;
      break;

    default:
      formattedArtifact += artifact.content;
  }

  return formattedArtifact;
}

/**
 * Generate executive metadata footer
 */
function generateExecutiveMetadata(
  session: any,
  messages: any[],
  artifacts: ExtractedArtifact[],
  tokensUsed: number
): string {
  const typeGroups = groupArtifactsByType(artifacts);
  const artifactCounts = Object.entries(typeGroups)
    .map(([type, arts]) => `${formatArtifactTypeLabel(type as ArtifactType)}: ${arts.length}`)
    .join(', ');

  // brand externalized: drop the brand clause when APP_NAME is unset
  const brand = process.env.APP_NAME || '';
  const platform = brand ? `${brand} Lumina v5` : 'Lumina v5';
  const generatedBy = brand ? `${brand} AI-Powered Notebook Curation` : 'AI-Powered Notebook Curation';

  return `## Metadata

- **Session ID:** ${session.id}
- **Conversation Turns:** ${messages.length}
- **Artifacts Generated:** ${artifacts.length}
- **Artifact Breakdown:** ${artifactCounts || 'None'}
- **AI Analysis Tokens Used:** ~${tokensUsed} tokens
- **Created:** ${session.firstCreated ? new Date(session.firstCreated).toISOString() : 'Unknown'}
- **Curated At:** ${new Date().toISOString()}
- **Curation Type:** AI-Powered Executive Summary
- **Platform:** ${platform}

---

*This document was automatically generated by ${generatedBy}.*
*The executive summary, insights, and artifact descriptions were created using AI analysis.*`;
}

// Helper functions

/**
 * Sample conversation to fit within token budget
 */
function sampleConversation(messages: any[], maxChars: number): string {
  const samples: string[] = [];
  let currentChars = 0;

  // Take first message, last message, and sample from middle
  const indicesToSample = [
    0, // First
    ...sampleIndices(messages.length, Math.floor(messages.length / 3)), // Middle samples
    messages.length - 1, // Last
  ];

  for (const idx of indicesToSample) {
    if (idx >= messages.length) continue;

    const message = messages[idx];
    const userPrompt = message.prompt || '';
    const assistantReply = message.reply || message.questMasterReply || (message.replies && message.replies[0]) || '';

    const messageSample = `User: ${userPrompt}\n\nAssistant: ${assistantReply}`;

    if (currentChars + messageSample.length > maxChars) break;

    samples.push(messageSample);
    currentChars += messageSample.length;
  }

  return samples.join('\n\n---\n\n');
}

/**
 * Sample indices from array
 */
function sampleIndices(length: number, count: number): number[] {
  const step = Math.floor(length / (count + 1));
  const indices: number[] = [];

  for (let i = 1; i <= count; i++) {
    indices.push(i * step);
  }

  return indices;
}

/**
 * Find conversation context around an artifact
 */
function findArtifactContext(artifact: ExtractedArtifact, messages: any[]): string {
  // Find the message containing this artifact
  const message = messages.find(m => m.id === artifact.messageId || m._id?.toString() === artifact.messageId);

  if (!message) return '';

  // Return prompt + reply that generated this artifact
  const prompt = message.prompt || '';
  const reply = message.reply || message.questMasterReply || '';

  return `User: ${prompt.substring(0, 200)}...\n\nAssistant: ${reply.substring(0, 200)}...`;
}

/**
 * Group artifacts by type
 */
function groupArtifactsByType(artifacts: ExtractedArtifact[]): Record<string, ExtractedArtifact[]> {
  return artifacts.reduce(
    (groups, artifact) => {
      const type = artifact.type;
      if (!groups[type]) {
        groups[type] = [];
      }
      groups[type].push(artifact);
      return groups;
    },
    {} as Record<string, ExtractedArtifact[]>
  );
}

/**
 * Format artifact type as readable label
 */
function formatArtifactTypeLabel(type: ArtifactType): string {
  const labels: Record<ArtifactType, string> = {
    [ArtifactType.CODE]: 'Code Snippets',
    [ArtifactType.REACT]: 'React Components',
    [ArtifactType.HTML]: 'HTML Pages',
    [ArtifactType.MERMAID]: 'Diagrams (Mermaid)',
    [ArtifactType.RECHARTS]: 'Data Visualizations',
    [ArtifactType.SVG]: 'SVG Graphics',
    [ArtifactType.QUESTMASTER_PLAN]: 'QuestMaster Plans',
    [ArtifactType.DEEP_RESEARCH]: 'Research Findings',
    [ArtifactType.IMAGE]: 'Images',
  };

  return labels[type] || type;
}

/**
 * Estimate tokens from text using standard LLM heuristic
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4); // Standard LLM heuristic: ~4 chars per token
}
