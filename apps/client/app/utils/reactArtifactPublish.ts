import type { ReactArtifactGroupRole } from './reactArtifactGroup';

/**
 * The index.html upload of a multi-file React publish: the entry and its sibling sources in one
 * JSON body, so the existing single-file draft flow and its size caps cover the whole app. Sent
 * only with `source.reactSiblings` (the keys of `files`); a single-file publish still uploads the
 * raw entry source. Decoded by the finalize handler (pages/api/publish/artifact/finalize.ts).
 */
export interface ReactPublishUpload {
  entry: string;
  files: Record<string, string>;
}

/**
 * The sibling sources an entry needs to publish, by identifier: only the files its imports reach.
 * Null when the artifact is not a multi-file entry or reaches no sibling, which publishes it as a
 * single file.
 */
export function reactPublishFiles(group: ReactArtifactGroupRole | undefined): Record<string, string> | null {
  if (group?.role !== 'entry') return null;
  const files: Record<string, string> = Object.create(null);
  for (const { identifier } of group.siblings) {
    if (typeof group.files[identifier] === 'string') files[identifier] = group.files[identifier];
  }
  return Object.keys(files).length > 0 ? files : null;
}

export function encodeReactPublishUpload(upload: ReactPublishUpload): string {
  return JSON.stringify({ entry: upload.entry, files: upload.files });
}

/** Parses an upload, requiring its files to be exactly `identifiers`; throws with the reason otherwise. */
export function decodeReactPublishUpload(raw: string, identifiers: readonly string[]): ReactPublishUpload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Multi-file React upload is not valid JSON.');
  }
  if (!isRecord(parsed) || typeof parsed.entry !== 'string' || !isRecord(parsed.files)) {
    throw new Error('Multi-file React upload must carry an entry source and a files map.');
  }
  // Null prototype: a "__proto__" key from JSON.parse must stay an ordinary entry.
  const files: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(parsed.files)) {
    if (typeof value !== 'string') throw new Error(`Multi-file React upload file "${key}" is not a source string.`);
    files[key] = value;
  }
  const keys = Object.keys(files);
  if (keys.length !== identifiers.length || !identifiers.every(id => Object.prototype.hasOwnProperty.call(files, id))) {
    throw new Error('Multi-file React upload files do not match the declared sibling identifiers.');
  }
  return { entry: parsed.entry, files };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
