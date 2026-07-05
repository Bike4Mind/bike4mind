import { ExtractedArtifact, CurationArtifactType as ArtifactType } from '@bike4mind/common';

/**
 * Template-based "Raw Transcript" markdown generator (Option 1) for curated notebooks.
 * Chronological, unaltered conversation with organized artifacts, suited to legal/compliance.
 * The LLM "Executive Summary" (Option 2) lives in llmMarkdownGenerator.
 */

export interface MarkdownGeneratorOptions {
  includeTimestamps: boolean;
  includeMetadata: boolean;
  includeTableOfContents: boolean;
  groupArtifactsByType: boolean;
}

const DEFAULT_OPTIONS: MarkdownGeneratorOptions = {
  includeTimestamps: true,
  includeMetadata: true,
  includeTableOfContents: true,
  groupArtifactsByType: true,
};

/**
 * Generate Option 1: Template-based markdown (Raw Transcript)
 *
 * Chronological, unaltered conversation with organized artifacts.
 * Perfect for HR, legal, compliance, or complete record-keeping.
 */
export function generateTranscriptMarkdown(
  session: any,
  messages: any[],
  artifacts: ExtractedArtifact[],
  options: Partial<MarkdownGeneratorOptions> = {}
): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const sections: string[] = [];

  // Header
  sections.push(generateHeader(session, messages, artifacts));

  // Table of Contents
  if (opts.includeTableOfContents) {
    sections.push(generateTableOfContents(artifacts));
  }

  // Summary Section
  if (session.summary) {
    sections.push(generateSummarySection(session));
  }

  // Conversation Section
  sections.push(generateConversationSection(messages, opts));

  // Artifacts Sections (grouped by type)
  if (artifacts.length > 0) {
    if (opts.groupArtifactsByType) {
      sections.push(generateArtifactsSectionGrouped(artifacts));
    } else {
      sections.push(generateArtifactsSectionChronological(artifacts));
    }
  }

  // Metadata Footer
  if (opts.includeMetadata) {
    sections.push(generateMetadataFooter(session, messages, artifacts));
  }

  return sections.filter(Boolean).join('\n\n---\n\n');
}

/**
 * Generate document header
 */
function generateHeader(session: any, messages: any[], artifacts: ExtractedArtifact[]): string {
  const created = session.firstCreated ? new Date(session.firstCreated).toLocaleDateString() : 'Unknown';
  const updated = session.lastUpdated ? new Date(session.lastUpdated).toLocaleDateString() : 'Unknown';

  return `# ${session.name}

**Curated Notebook Transcript**

- **Created:** ${created}
- **Last Updated:** ${updated}
- **Messages:** ${messages.length}
- **Artifacts:** ${artifacts.length}
- **Language:** ${session.language || 'en'}`;
}

/**
 * Generate table of contents
 */
function generateTableOfContents(artifacts: ExtractedArtifact[]): string {
  const sections = ['## Table of Contents\n'];

  sections.push('- [Summary](#summary)');
  sections.push('- [Conversation](#conversation)');

  if (artifacts.length > 0) {
    sections.push('- [Artifacts](#artifacts)');

    // Add subsections for each artifact type present
    const typeGroups = groupArtifactsByType(artifacts);
    Object.keys(typeGroups).forEach(type => {
      const typeLabel = formatArtifactTypeLabel(type as ArtifactType);
      const anchor = typeLabel.toLowerCase().replace(/\s+/g, '-');
      sections.push(`  - [${typeLabel}](#${anchor})`);
    });
  }

  return sections.join('\n');
}

/**
 * Generate summary section
 */
function generateSummarySection(session: any): string {
  const summarizedDate = session.summaryAt ? new Date(session.summaryAt).toLocaleDateString() : 'Unknown';

  return `## Summary

*Generated on ${summarizedDate}*

${session.summary}`;
}

/**
 * Generate conversation section
 */
function generateConversationSection(messages: any[], options: MarkdownGeneratorOptions): string {
  const lines = ['## Conversation\n'];

  messages.forEach((message, index) => {
    const timestamp = message.timestamp ? new Date(message.timestamp).toLocaleString() : '';
    const showTimestamp = options.includeTimestamps && timestamp;

    // User prompt
    if (message.prompt) {
      lines.push(`### ${index + 1}. User${showTimestamp ? ` (${timestamp})` : ''}\n`);
      lines.push(cleanMessageContent(message.prompt));
      lines.push('');
    }

    // Assistant reply
    const reply = message.questMasterReply || message.reply || (message.replies && message.replies[0]);
    if (reply) {
      lines.push(`### ${index + 1}. Assistant${showTimestamp ? ` (${timestamp})` : ''}\n`);
      lines.push(cleanMessageContent(reply));
      lines.push('');
    }
  });

  return lines.join('\n');
}

/**
 * Generate artifacts section (grouped by type)
 */
function generateArtifactsSectionGrouped(artifacts: ExtractedArtifact[]): string {
  const sections = ['## Artifacts\n'];
  const typeGroups = groupArtifactsByType(artifacts);

  // Sort by type priority (code first, then diagrams, then research)
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

  sortedTypes.forEach(type => {
    const artifactType = type as ArtifactType;
    const typeArtifacts = typeGroups[type];
    const typeLabel = formatArtifactTypeLabel(artifactType);

    sections.push(`### ${typeLabel}\n`);

    typeArtifacts.forEach((artifact, index) => {
      sections.push(formatArtifact(artifact, index + 1));
      sections.push('');
    });
  });

  return sections.join('\n');
}

/**
 * Generate artifacts section (chronological order)
 */
function generateArtifactsSectionChronological(artifacts: ExtractedArtifact[]): string {
  const sections = ['## Artifacts\n'];

  artifacts.forEach((artifact, index) => {
    sections.push(formatArtifact(artifact, index + 1));
    sections.push('');
  });

  return sections.join('\n');
}

/**
 * Format a single artifact for markdown
 */
function formatArtifact(artifact: ExtractedArtifact, index: number): string {
  const title = artifact.metadata?.title || `${formatArtifactTypeLabel(artifact.type)} #${index}`;
  const timestamp = artifact.timestamp.toLocaleString();

  switch (artifact.type) {
    case ArtifactType.CODE:
    case ArtifactType.REACT:
    case ArtifactType.HTML:
      return `#### ${index}. ${title}

*Type:* ${artifact.type} | *Language:* ${artifact.language || 'unknown'} | *Created:* ${timestamp}

\`\`\`${artifact.language || 'text'}
${artifact.content}
\`\`\``;

    case ArtifactType.MERMAID:
      return `#### ${index}. ${title}

*Type:* Mermaid Diagram | *Created:* ${timestamp}

\`\`\`mermaid
${artifact.content}
\`\`\``;

    case ArtifactType.RECHARTS:
      return `#### ${index}. ${title}

*Type:* Data Visualization | *Created:* ${timestamp}

\`\`\`json
${artifact.content}
\`\`\``;

    case ArtifactType.SVG:
      return `#### ${index}. ${title}

*Type:* SVG Graphic | *Created:* ${timestamp}

\`\`\`svg
${artifact.content}
\`\`\``;

    case ArtifactType.QUESTMASTER_PLAN:
      return `#### ${index}. QuestMaster Plan

*Plan ID:* ${artifact.metadata?.planId} | *Created:* ${timestamp}

> This conversation included a QuestMaster plan (ID: ${artifact.metadata?.planId})`;

    case ArtifactType.DEEP_RESEARCH:
      return formatDeepResearchArtifact(artifact, index, timestamp);

    case ArtifactType.IMAGE:
      return `#### ${index}. Image

*Path:* ${artifact.metadata?.path} | *Created:* ${timestamp}

![Image](${artifact.content})`;

    default:
      return `#### ${index}. ${title}

${artifact.content}`;
  }
}

/**
 * Format Deep Research artifact with findings and sources
 */
function formatDeepResearchArtifact(artifact: ExtractedArtifact, index: number, timestamp: string): string {
  const metadata = artifact.metadata || {};
  const research = JSON.parse(artifact.content);

  const sections = [
    `#### ${index}. Deep Research: ${metadata.topic || 'Unknown Topic'}`,
    '',
    `*Findings:* ${metadata.findingsCount || 0} | *Sources:* ${metadata.sourcesCount || 0} | *Depth:* ${metadata.depth || 0} | *Created:* ${timestamp}`,
    '',
  ];

  // Add findings
  if (research.findings && research.findings.length > 0) {
    sections.push('**Key Findings:**\n');
    research.findings.forEach((finding: any, i: number) => {
      sections.push(`${i + 1}. ${finding.text}`);
      if (finding.source) {
        sections.push(`   *Source:* ${finding.source}`);
      }
      sections.push('');
    });
  }

  // Add sources
  if (research.sources && research.sources.length > 0) {
    sections.push('**Sources:**\n');
    research.sources.forEach((source: any, i: number) => {
      sections.push(`${i + 1}. **${source.title}**`);
      sections.push(`   - URL: ${source.url}`);
      if (source.description) {
        sections.push(`   - ${source.description}`);
      }
      sections.push('');
    });
  }

  return sections.join('\n');
}

/**
 * Generate metadata footer
 */
function generateMetadataFooter(session: any, messages: any[], artifacts: ExtractedArtifact[]): string {
  const typeGroups = groupArtifactsByType(artifacts);
  const artifactCounts = Object.entries(typeGroups)
    .map(([type, arts]) => `${formatArtifactTypeLabel(type as ArtifactType)}: ${arts.length}`)
    .join(', ');

  // brand externalized: drop the brand clause when APP_NAME is unset
  const brand = process.env.APP_NAME || '';
  const platform = brand ? `${brand} Lumina v5` : 'Lumina v5';
  const generatedBy = brand ? `${brand} Notebook Curation` : 'Notebook Curation';

  return `## Metadata

- **Session ID:** ${session.id}
- **Total Messages:** ${messages.length}
- **Total Artifacts:** ${artifacts.length}
- **Artifact Breakdown:** ${artifactCounts || 'None'}
- **Created:** ${session.firstCreated ? new Date(session.firstCreated).toISOString() : 'Unknown'}
- **Last Updated:** ${session.lastUpdated ? new Date(session.lastUpdated).toISOString() : 'Unknown'}
- **Curated At:** ${new Date().toISOString()}
- **Platform:** ${platform}

---

*This document was automatically generated by ${generatedBy}.*`;
}

/**
 * Helper: Group artifacts by type
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
 * Helper: Format artifact type as readable label
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
 * Helper: Clean message content (remove artifact tags, normalize whitespace)
 */
function cleanMessageContent(content: string): string {
  // Remove <artifact> tags (already extracted)
  let cleaned = content.replace(/<artifact\s+.*?>([\s\S]*?)<\/artifact>/gi, '');

  // Remove <think> tags (internal reasoning)
  cleaned = cleaned.replace(/<think>([\s\S]*?)<\/think>/gi, '');

  // Normalize whitespace
  cleaned = cleaned.trim();

  return cleaned;
}
