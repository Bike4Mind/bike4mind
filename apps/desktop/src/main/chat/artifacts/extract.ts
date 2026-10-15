import { randomUUID } from 'node:crypto';
import { parseArtifacts } from '@bike4mind/utils/artifactParser';
import type { ChatArtifact, ChatMessage } from '@shared/chat';

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

/**
 * One stored assistant turn as the model should see it again: prose with the artifact markup
 * put back.
 *
 * Without this, a follow-up like "make the button blue" reaches a model that can no longer see
 * the button - `ChatMessage.content` holds only the text around the artifact, which is what
 * lets the body be stored once instead of twice. The rebuilt tag is not byte-identical to the
 * original (attribute order and whitespace are normalized); it carries the same identifier,
 * type, title and body, which is what the next turn is working from.
 */
export function restoreArtifactMarkup(message: ChatMessage): string {
  const artifacts = message.artifacts ?? [];
  if (artifacts.length === 0) return message.content;

  const blocks = artifacts.map(artifact => {
    const attributes = [
      artifact.identifier ? ` identifier="${escapeAttribute(artifact.identifier)}"` : '',
      artifact.mimeType ? ` type="${escapeAttribute(artifact.mimeType)}"` : '',
      ` title="${escapeAttribute(artifact.title)}"`,
      artifact.language ? ` language="${escapeAttribute(artifact.language)}"` : '',
    ].join('');
    return `<artifact${attributes}>\n${artifact.content}\n</artifact>`;
  });

  return [message.content, ...blocks].filter(part => part.length > 0).join('\n\n');
}

/**
 * The attribute parser this pairs with (ATTRIBUTE_REGEX in the shared parser) anchors a value
 * to its own quote kind and has no escape mechanism, so a double quote inside a value would end
 * it early and the rest would be read as further attributes. Dropping it is the one lossless
 * option available: an entity would be replayed literally, and a single-quoted value would
 * break on the next apostrophe instead.
 */
function escapeAttribute(value: string): string {
  return value.replace(/"/g, '');
}
