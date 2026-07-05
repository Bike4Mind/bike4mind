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
  maxSummaryLength?: number; // Max tokens for summary generation
}

const DEFAULT_OPTIONS: LLMMarkdownGeneratorOptions = {
  includeTimestamps: false, // Executive summaries don't need timestamps
  includeMetadata: true,
  includeTableOfContents: true,
  maxSummaryLength: 2000, // ~2000 tokens for summary
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
 */
export async function generateExecutiveSummaryMarkdown(
  session: any,
  messages: any[],
  artifacts: ExtractedArtifact[],
  llmContext: LLMContext,
  model: string,
  options: Partial<LLMMarkdownGeneratorOptions> = {}
): Promise<{ markdown: string; tokensUsed: number }> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const sections: string[] = [];
  let totalTokensUsed = 0;

  // Helper to generate text from LLM
  const generateText = async (prompt: string): Promise<string> => {
    let result = '';
    await llmContext.complete(
      model,
      [{ role: 'user', content: prompt }],
      { temperature: 0.7, stream: false },
      async chunks => {
        result += chunks[0] || '';
      }
    );
    return result;
  };

  // Header
  sections.push(generateExecutiveHeader(session, messages, artifacts));

  // Table of Contents
  if (opts.includeTableOfContents) {
    sections.push(generateExecutiveTOC());
  }

  // Generate AI-powered Executive Summary
  const summaryResult = await generateAIExecutiveSummary(session, messages, generateText, opts.maxSummaryLength);
  sections.push(summaryResult.markdown);
  totalTokensUsed += summaryResult.tokensUsed;

  // Generate AI-powered Key Insights
  const insightsResult = await generateAIKeyInsights(messages, generateText);
  sections.push(insightsResult.markdown);
  totalTokensUsed += insightsResult.tokensUsed;

  // Generate AI-powered Decisions & Actions
  const decisionsResult = await generateAIDecisionsAndActions(messages, generateText);
  sections.push(decisionsResult.markdown);
  totalTokensUsed += decisionsResult.tokensUsed;

  // Code & Artifacts (with AI-generated descriptions)
  if (artifacts.length > 0) {
    const artifactsResult = await generateAIArtifactsSection(artifacts, messages, generateText);
    sections.push(artifactsResult.markdown);
    totalTokensUsed += artifactsResult.tokensUsed;
  }

  // Metadata Footer
  if (opts.includeMetadata) {
    sections.push(generateExecutiveMetadata(session, messages, artifacts, totalTokensUsed));
  }

  return {
    markdown: sections.filter(Boolean).join('\n\n---\n\n'),
    tokensUsed: totalTokensUsed,
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
 * Generate AI-powered executive summary
 */
async function generateAIExecutiveSummary(
  session: any,
  messages: any[],
  generateText: (prompt: string) => Promise<string>,
  maxTokens?: number
): Promise<{ markdown: string; tokensUsed: number }> {
  // Prepare conversation context (sample key messages)
  const conversationSample = sampleConversation(messages, 5000); // ~5000 tokens max

  const prompt = `You are an AI assistant helping to curate a notebook conversation into an executive summary.

Session: ${session.name}
Total Messages: ${messages.length}

Conversation Sample:
${conversationSample}

Generate a comprehensive executive summary that:
1. Explains what the conversation was about (1-2 paragraphs)
2. Highlights the main topics discussed
3. Describes the outcome or final state

Write in a professional, concise style suitable for knowledge sharing.`;

  const text = await generateText(prompt);
  const tokensUsed = estimateTokens(prompt + text);

  return {
    markdown: `## Executive Summary\n\n${text}`,
    tokensUsed,
  };
}

/**
 * Generate AI-powered key insights
 */
async function generateAIKeyInsights(
  messages: any[],
  generateText: (prompt: string) => Promise<string>
): Promise<{ markdown: string; tokensUsed: number }> {
  const conversationSample = sampleConversation(messages, 5000);

  const prompt = `Analyze this conversation and extract the top 5-7 key insights or learnings.

Conversation:
${conversationSample}

Format your response as a bullet list of key insights. Each insight should be:
- Concise (1-2 sentences)
- Actionable or informative
- Focused on technical or strategic learnings

Example format:
- **Understanding of X**: Brief explanation
- **Decision on Y**: What was decided and why
- **Technical approach for Z**: Key technical insight`;

  const text = await generateText(prompt);
  const tokensUsed = estimateTokens(prompt + text);

  return {
    markdown: `## Key Insights\n\n${text}`,
    tokensUsed,
  };
}

/**
 * Generate AI-powered decisions and actions
 */
async function generateAIDecisionsAndActions(
  messages: any[],
  generateText: (prompt: string) => Promise<string>
): Promise<{ markdown: string; tokensUsed: number }> {
  const conversationSample = sampleConversation(messages, 5000);

  const prompt = `Analyze this conversation and identify key decisions made and action items.

Conversation:
${conversationSample}

Create two sections:

### Decisions Made
List 3-5 major decisions with brief rationale

### Action Items
List any next steps or TODOs mentioned

Format as markdown with bullet points.`;

  const text = await generateText(prompt);
  const tokensUsed = estimateTokens(prompt + text);

  return {
    markdown: `## Decisions & Actions\n\n${text}`,
    tokensUsed,
  };
}

/**
 * Generate AI-powered artifacts section with descriptions
 * OPTIMIZED: Batches all artifact descriptions into a single LLM call
 */
async function generateAIArtifactsSection(
  artifacts: ExtractedArtifact[],
  messages: any[],
  generateText: (prompt: string) => Promise<string>
): Promise<{ markdown: string; tokensUsed: number }> {
  const sections: string[] = ['## Code & Artifacts\n'];
  let totalTokensUsed = 0;

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
  totalTokensUsed += batchDescriptionResult.tokensUsed;

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
    tokensUsed: totalTokensUsed,
  };
}

/**
 * Generate AI descriptions for all artifacts in a single batched LLM call
 * OPTIMIZATION: Reduces N LLM calls to 1 LLM call, saving significant tokens and cost
 */
async function generateBatchedArtifactDescriptions(
  artifacts: ExtractedArtifact[],
  messages: any[],
  generateText: (prompt: string) => Promise<string>
): Promise<{ descriptions: string[]; tokensUsed: number }> {
  // If no artifacts, return empty
  if (artifacts.length === 0) {
    return { descriptions: [], tokensUsed: 0 };
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

  const text = await generateText(batchPrompt);
  const tokensUsed = estimateTokens(batchPrompt + text);

  // Parse the numbered list response into individual descriptions
  const descriptions = parseNumberedListResponse(text, artifacts.length);

  return {
    descriptions,
    tokensUsed,
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
