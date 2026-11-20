import { randomUUID } from 'node:crypto';
import { parseArtifacts } from '@bike4mind/utils/artifactParser';
import type { ChatArtifact } from '@shared/chat';

/**
 * Pull the <artifact> blocks out of one reply.
 *
 * The matcher is the shared one from `@bike4mind/utils/artifactParser`, not a local regex. Its
 * own header warns that this repo has accumulated several artifact matchers whose quote
 * handling diverged; a desktop copy would be one more, and the attribute pattern it is built
 * from (`ARTIFACT_ATTRS_PATTERN`) is what keeps it in step with the web parser.
 *
 * A reply with no artifact in it comes back with its text untouched and an empty list - the
 * overwhelmingly common case, and the reason this is a plain call rather than a gate.
 */
export function extractArtifacts(content: string): { content: string; artifacts: ChatArtifact[] } {
  const parsed = parseArtifacts(content);
  if (parsed.artifacts.length === 0) return { content, artifacts: [] };

  // Re-sorted because the shared parser leaves them in REVERSE document order: it sorts the
  // array in place by descending startIndex so it can splice the tags out back-to-front, and
  // never puts it back. A reply that emits a diagram and then the code for it would otherwise
  // show the two cards the other way round.
  const artifacts = [...parsed.artifacts]
    .sort((a, b) => a.startIndex - b.startIndex)
    .map<ChatArtifact>(artifact => ({
      id: randomUUID(),
      ...(artifact.identifier ? { identifier: artifact.identifier } : {}),
      type: artifact.type,
      mimeType: mimeTypeOf(artifact.fullMatch),
      title: artifact.title,
      content: artifact.content,
      ...(artifact.language ? { language: artifact.language } : {}),
    }));

  return { content: parsed.cleanedContent.trim(), artifacts };
}

/**
 * The `type` attribute as the model wrote it.
 *
 * Kept verbatim rather than mapped back from `ParsedArtifact.type`, because that mapping is
 * many-to-one: `mapMimeTypeToArtifactType` folds `text/html` and a bare `html` to the same
 * 'html', so a reverse lookup would rewrite what the model sent. Restoring the markup with a
 * different attribute than the model chose is a change to its own transcript.
 */
function mimeTypeOf(fullMatch: string): string {
  return /\btype=(?:"([^"]*)"|'([^']*)')/.exec(fullMatch)?.slice(1).find(Boolean) ?? '';
}

export { restoreArtifactMarkup } from '@shared/artifactMarkup';
