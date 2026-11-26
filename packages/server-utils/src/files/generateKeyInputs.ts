import { FabFileSourceType } from '@bike4mind/common';
import { fabFileRepository } from '@bike4mind/database';
import { holdsApiKeyScope, type ScopedRequest } from '../middlewares/apiKeyScopeGate';
import { isValidObjectId } from '../utils/objectId';
import { FILES_READ_SCOPES } from './fileScopes';
import { isOwnedGenerateUpload } from './generateUploadMarker';

type InputFileLoader<R> = (userId: string, fileId: string) => Promise<R | null>;

/**
 * A generation job re-publishes its input files' content, so an API key without files:read may only name
 * a file it could reach without that scope: the owner's generated output or an upload an ai:generate-only
 * key staged (see GENERATE_UPLOAD_MARKER). Any other id loads as missing, the same refusal the job gives a
 * file the caller does not own. JWT callers and keys holding files:read get `load` unchanged.
 */
export function limitInputFilesForKey<R>(req: ScopedRequest, load: InputFileLoader<R>): InputFileLoader<R> {
  if (!req.apiKeyInfo || holdsApiKeyScope(req, FILES_READ_SCOPES)) return load;
  return async (userId, fileId) => ((await isGenerateKeyInputFile(userId, fileId)) ? load(userId, fileId) : null);
}

export async function isGenerateKeyInputFile(userId: string, fileId: string): Promise<boolean> {
  if (!isValidObjectId(fileId)) return false;
  const file = await fabFileRepository.findByIdAndUserId(fileId, userId);
  if (!file || file.deletedAt) return false;
  return file.sourceType === FabFileSourceType.TOOL_GENERATED || isOwnedGenerateUpload(file, userId);
}
