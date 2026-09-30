import {
  isSafeQaPath,
  qaObjectPrefix,
  QA_UPLOAD_CONTENT_TYPES,
  QA_UPLOAD_LIMITS,
  type QaUploadRequest,
  type QaUploadResponse,
} from '@bike4mind/common';

export interface PlanUploadsDeps {
  presign(key: string, contentType: string, bytes: number): Promise<string>;
}

/** Validates each file against its kind's type and size cap, then presigns it under the run's own prefix. */
export async function planUploads(req: QaUploadRequest, deps: PlanUploadsDeps): Promise<QaUploadResponse> {
  const uploads: QaUploadResponse['uploads'] = [];
  const rejected: QaUploadResponse['rejected'] = [];
  for (const file of req.files) {
    const allowed: readonly string[] = QA_UPLOAD_CONTENT_TYPES[file.kind];
    if (!isSafeQaPath(file.path)) {
      rejected.push({ path: file.path, reason: 'unsafe path' });
    } else if (!allowed.includes(file.content_type)) {
      rejected.push({ path: file.path, reason: `content type ${file.content_type} not allowed for ${file.kind}` });
    } else if (file.bytes > QA_UPLOAD_LIMITS[file.kind]) {
      rejected.push({ path: file.path, reason: `exceeds ${QA_UPLOAD_LIMITS[file.kind]} bytes for ${file.kind}` });
    } else {
      const area = file.kind === 'report' ? 'report' : 'media';
      const key = qaObjectPrefix(req.product, req.external_run_id, area) + file.path;
      uploads.push({ path: file.path, key, url: await deps.presign(key, file.content_type, file.bytes) });
    }
  }
  return { uploads, rejected };
}
