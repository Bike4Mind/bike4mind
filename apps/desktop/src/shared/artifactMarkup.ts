import type { ChatArtifact, ChatMessage } from './chat';

/**
 * One stored assistant turn as the model should see it again: prose with the artifact markup
 * put back.
 *
 * Without this, a follow-up like "make the button blue" reaches a model that can no longer see
 * the button - `ChatMessage.content` holds only the text around the artifact, which is what
 * lets the body be stored once instead of twice. The rebuilt tag is not byte-identical to the
 * original (attribute order and whitespace are normalized); it carries the same identifier,
 * type, title and body, which is what the next turn is working from.
 *
 * Shared so the context estimate (contextLimit.resentReplyTokens) counts exactly what the wire
 * (ChatService.toCompletionMessages) sends.
 */
export function restoreArtifactMarkup(message: ChatMessage): string {
  const artifacts = message.artifacts ?? [];
  if (artifacts.length === 0) return message.content;
  return [message.content, ...artifacts.map(artifactMarkup)].filter(part => part.length > 0).join('\n\n');
}

export function artifactMarkup(artifact: ChatArtifact): string {
  const attributes = [
    artifact.identifier ? ` identifier="${escapeAttribute(artifact.identifier)}"` : '',
    artifact.mimeType ? ` type="${escapeAttribute(artifact.mimeType)}"` : '',
    ` title="${escapeAttribute(artifact.title)}"`,
    artifact.language ? ` language="${escapeAttribute(artifact.language)}"` : '',
  ].join('');
  return `<artifact${attributes}>\n${artifact.content}\n</artifact>`;
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
