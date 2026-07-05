import {
  ExtractedArtifact,
  CurationArtifactType as ArtifactType,
  CurationOptions,
  mapMimeTypeToArtifactType as mapMimeTypeToSharedArtifactType,
} from '@bike4mind/common';

/**
 * Extracts code, diagrams, and other artifacts from conversation messages.
 * Server-side adaptation of the client artifact parsing patterns.
 */

const ARTIFACT_TAG_REGEX = /<artifact\s+(.*?)>([\s\S]*?)<\/artifact>/gi;
const ATTRIBUTE_REGEX = /(\w+)=["']([^"']*?)["']/g;
const CODE_BLOCK_REGEX = /```(\w+)?\s*([\s\S]*?)```/g;

/**
 * Extract artifacts from a single message
 */
export function extractArtifactsFromMessage(message: any, options: CurationOptions): ExtractedArtifact[] {
  const artifacts: ExtractedArtifact[] = [];
  const messageId = message.id || message._id?.toString() || 'unknown';
  const timestamp = message.timestamp ? new Date(message.timestamp) : new Date();

  // Combine all text content from the message
  const textContent = [
    message.prompt || '',
    message.reply || '',
    ...(message.replies || []),
    message.questMasterReply || '',
  ]
    .filter(Boolean)
    .join('\n\n');

  if (!textContent) {
    return artifacts;
  }

  // 1. Extract formal <artifact> tags (Claude/Anthropic format)
  if (options.includeCode || options.includeDiagrams || options.includeDataViz) {
    const tagArtifacts = extractArtifactTags(textContent, messageId, timestamp);
    artifacts.push(...tagArtifacts);
  }

  // 2. Extract code blocks (fallback for messages without artifact tags)
  if (options.includeCode) {
    const codeArtifacts = extractCodeBlocks(textContent, messageId, timestamp);
    artifacts.push(...codeArtifacts);
  }

  // 3. Extract QuestMaster plans
  if (options.includeQuestMaster && message.questMasterPlanId) {
    artifacts.push({
      type: ArtifactType.QUESTMASTER_PLAN,
      content: message.questMasterPlanId,
      messageId,
      timestamp,
      metadata: {
        planId: message.questMasterPlanId,
      },
    });
  }

  // 4. Extract Deep Research findings
  if (options.includeResearch && message.deepResearchState) {
    const research = message.deepResearchState;
    artifacts.push({
      type: ArtifactType.DEEP_RESEARCH,
      content: JSON.stringify(research, null, 2),
      messageId,
      timestamp,
      metadata: {
        findingsCount: research.findings?.length || 0,
        sourcesCount: research.sources?.length || 0,
        depth: research.depth,
        completed: research.completed,
        topic: research.topic,
      },
    });
  }

  // 5. Extract images
  if (options.includeImages && message.images && message.images.length > 0) {
    message.images.forEach((imagePath: string, index: number) => {
      artifacts.push({
        type: ArtifactType.IMAGE,
        content: imagePath,
        messageId,
        timestamp,
        metadata: {
          index,
          path: imagePath,
        },
      });
    });
  }

  return artifacts;
}

/**
 * Extract artifacts from <artifact> tags
 */
function extractArtifactTags(content: string, messageId: string, timestamp: Date): ExtractedArtifact[] {
  const artifacts: ExtractedArtifact[] = [];
  let match;

  ARTIFACT_TAG_REGEX.lastIndex = 0;

  while ((match = ARTIFACT_TAG_REGEX.exec(content)) !== null) {
    const [, attributesString, artifactContent] = match;

    // Parse attributes
    const attributes: Record<string, string> = {};
    let attrMatch;
    ATTRIBUTE_REGEX.lastIndex = 0;

    while ((attrMatch = ATTRIBUTE_REGEX.exec(attributesString)) !== null) {
      const [, key, value] = attrMatch;
      attributes[key] = value;
    }

    const mimeType = attributes.type || '';
    const title = attributes.title || 'Untitled';
    const language = attributes.language;
    const identifier = attributes.identifier;

    const artifactType = mapMimeTypeToArtifactType(mimeType);

    if (artifactType) {
      artifacts.push({
        type: artifactType,
        content: artifactContent.trim(),
        language: language || inferLanguageFromType(artifactType),
        messageId,
        timestamp,
        metadata: {
          title,
          identifier,
          mimeType,
        },
      });
    }
  }

  return artifacts;
}

/**
 * Extract code blocks from markdown-style fenced code
 */
function extractCodeBlocks(content: string, messageId: string, timestamp: Date): ExtractedArtifact[] {
  const artifacts: ExtractedArtifact[] = [];
  let match;

  CODE_BLOCK_REGEX.lastIndex = 0;

  while ((match = CODE_BLOCK_REGEX.exec(content)) !== null) {
    const [, language, codeContent] = match;

    if (!codeContent || !codeContent.trim()) {
      continue;
    }

    // Skip if this is a very small snippet (< 3 lines)
    const lineCount = codeContent.trim().split('\n').length;
    if (lineCount < 3) {
      continue;
    }

    // Determine artifact type based on language
    const lang = (language || 'text').toLowerCase();
    let artifactType: ArtifactType;

    if (['mermaid'].includes(lang)) {
      artifactType = ArtifactType.MERMAID;
    } else if (['recharts'].includes(lang)) {
      artifactType = ArtifactType.RECHARTS;
    } else if (['svg', 'xml'].includes(lang)) {
      artifactType = ArtifactType.SVG;
    } else if (['html', 'htm'].includes(lang)) {
      artifactType = ArtifactType.HTML;
    } else if (
      ['tsx', 'jsx', 'javascript', 'typescript', 'react'].includes(lang) &&
      (codeContent.includes('useState') || codeContent.includes('useEffect') || codeContent.includes('export default'))
    ) {
      artifactType = ArtifactType.REACT;
    } else {
      artifactType = ArtifactType.CODE;
    }

    artifacts.push({
      type: artifactType,
      content: codeContent.trim(),
      language: lang || 'text',
      messageId,
      timestamp,
      metadata: {
        lineCount,
      },
    });
  }

  return artifacts;
}

/**
 * Map MIME type to a curation artifact type. Delegates MIME parsing to the shared single source
 * of truth (@bike4mind/common) - this used to be a drifting duplicate copy - then bridges the
 * shared string-union result to the CurationArtifactType enum. Types the shared mapper
 * recognizes but curation doesn't model (lattice, blog-draft) map to null.
 */
export function mapMimeTypeToArtifactType(mimeType: string): ArtifactType | null {
  switch (mapMimeTypeToSharedArtifactType(mimeType)) {
    case 'react':
      return ArtifactType.REACT;
    case 'html':
      return ArtifactType.HTML;
    case 'svg':
      return ArtifactType.SVG;
    case 'mermaid':
      return ArtifactType.MERMAID;
    case 'recharts':
      return ArtifactType.RECHARTS;
    case 'code':
    case 'python': // curation has no separate python type - treat as code
      return ArtifactType.CODE;
    default:
      return null;
  }
}

/**
 * Infer language from artifact type
 */
function inferLanguageFromType(type: ArtifactType): string | undefined {
  const languageMap: Record<ArtifactType, string | undefined> = {
    [ArtifactType.CODE]: 'typescript',
    [ArtifactType.REACT]: 'tsx',
    [ArtifactType.MERMAID]: 'mermaid',
    [ArtifactType.RECHARTS]: 'json',
    [ArtifactType.SVG]: 'xml',
    [ArtifactType.HTML]: 'html',
    [ArtifactType.QUESTMASTER_PLAN]: undefined,
    [ArtifactType.DEEP_RESEARCH]: 'json',
    [ArtifactType.IMAGE]: undefined,
  };

  return languageMap[type];
}
