/**
 * Pure planning helpers for the bulk PDF data-lake ingest script.
 * Kept free of I/O so the selection/dedup rules are unit-testable.
 */

export interface CandidateFile {
  absPath: string;
  relativePath: string;
  fileName: string;
  fileSize: number;
}

export interface HashedCandidate extends CandidateFile {
  contentHash: string;
}

/** Subset of an existing lake FabFile relevant to dedup. */
export interface ExistingLakeFile {
  fileName: string;
  fileSize?: number;
  contentHash?: string | null;
}

/** Existing lake FabFile with the fields needed to detect lost-S3-event orphans. */
export interface ExistingLakeDoc extends ExistingLakeFile {
  id: string;
  status?: string;
  createdAt?: Date;
}

/**
 * Partition existing lake files into ones the dedup may trust and stale
 * 'pending' orphans. In this script's flow the S3 object lands BEFORE the
 * FabFile doc is created, so a doc still 'pending' past the cutoff means its
 * ObjectCreated event was lost: the file was never chunked and no recovery
 * path can see it (requeue requires status 'complete'). Treating it as
 * existing would hide the loss forever; the caller soft-deletes it and
 * re-uploads instead. Docs without a status are kept usable - never delete
 * what we do not understand.
 */
export const splitStalePending = (
  docs: ExistingLakeDoc[],
  cutoff: Date
): { usable: ExistingLakeDoc[]; stalePending: ExistingLakeDoc[] } => {
  const usable: ExistingLakeDoc[] = [];
  const stalePending: ExistingLakeDoc[] = [];
  for (const doc of docs) {
    const isStale = doc.status === 'pending' && doc.createdAt !== undefined && doc.createdAt < cutoff;
    (isStale ? stalePending : usable).push(doc);
  }
  return { usable, stalePending };
};

export interface FilterResult {
  accepted: CandidateFile[];
  skippedOversize: CandidateFile[];
  skippedNonPdf: CandidateFile[];
}

/**
 * Keep visible *.pdf files strictly under maxFileBytes. The size check mirrors
 * fabFileService createFabFile ("fileSize >= maxFileSize" rejects), so anything
 * accepted here cannot be bounced later by the service.
 */
export const filterPdfCandidates = (files: CandidateFile[], maxFileBytes: number): FilterResult => {
  const result: FilterResult = { accepted: [], skippedOversize: [], skippedNonPdf: [] };
  for (const file of files) {
    // Any dot-segment (hidden file OR hidden ancestor dir like .git/) is junk.
    const isHidden = file.fileName.startsWith('.') || file.relativePath.split(/[\\/]/).some(seg => seg.startsWith('.'));
    const isPdf = file.fileName.toLowerCase().endsWith('.pdf');
    if (isHidden || !isPdf) {
      result.skippedNonPdf.push(file);
    } else if (file.fileSize >= maxFileBytes) {
      result.skippedOversize.push(file);
    } else {
      result.accepted.push(file);
    }
  }
  return result;
};

/**
 * Where a lake definition lives, plus everything the membership scope needs.
 * `fileTagPrefix` + `createdByUserId` feed buildDataLakeMembershipFilter, whose
 * prefix arm only applies when both are present - so a static registry lake,
 * which has no creator, correctly falls back to meta-tag-only membership.
 */
export interface LakeTarget {
  source: 'db' | 'static';
  slug: string;
  name: string;
  datalakeTag: string;
  fileTagPrefix?: string;
  createdByUserId?: string;
  /** DB document id; absent for static lakes (no doc to recompute stats on). */
  id?: string;
}

interface DbLakeInput {
  id: string;
  slug: string;
  name: string;
  datalakeTag: string;
  fileTagPrefix?: string;
  createdByUserId?: string;
}

interface StaticLakeInput {
  slug: string;
  name: string;
  datalakeTag: string;
  fileTagPrefix?: string;
}

/**
 * Resolve the ingest target. DB lakes win (they carry write authorization and
 * stats); static registry lakes (e.g. premium overlay entries) have no Mongo
 * doc, so the caller must gate them on platform-admin instead of the creator
 * check, and their stats cannot be persisted.
 */
export const resolveLakeTarget = (
  slug: string,
  dbLake: DbLakeInput | null,
  staticConfigs: StaticLakeInput[]
): LakeTarget | null => {
  if (dbLake) {
    return {
      source: 'db',
      id: dbLake.id,
      slug: dbLake.slug,
      name: dbLake.name,
      datalakeTag: dbLake.datalakeTag,
      fileTagPrefix: dbLake.fileTagPrefix,
      createdByUserId: dbLake.createdByUserId,
    };
  }
  const staticLake = staticConfigs.find(l => l.slug === slug);
  if (staticLake) {
    return {
      source: 'static',
      slug: staticLake.slug,
      name: staticLake.name,
      datalakeTag: staticLake.datalakeTag,
      fileTagPrefix: staticLake.fileTagPrefix,
      createdByUserId: undefined,
    };
  }
  return null;
};

export interface UploadPlan {
  toUpload: HashedCandidate[];
  skippedExisting: HashedCandidate[];
  skippedDuplicateInBatch: HashedCandidate[];
}

/**
 * Decide what actually needs uploading. Primary dedup key is the sha256
 * contentHash; fileName+fileSize is the fallback for lake files ingested
 * before hashes were recorded. Duplicate hashes inside the batch itself keep
 * the first occurrence, so re-running a partially-completed ingest is a no-op
 * for everything that already landed.
 */
export const planUploads = (candidates: HashedCandidate[], existing: ExistingLakeFile[]): UploadPlan => {
  const existingHashes = new Set(existing.map(f => f.contentHash).filter(Boolean) as string[]);
  const existingNameSize = new Set(
    existing.filter(f => typeof f.fileSize === 'number').map(f => `${f.fileName} ${f.fileSize}`)
  );

  const plan: UploadPlan = { toUpload: [], skippedExisting: [], skippedDuplicateInBatch: [] };
  const seenInBatch = new Set<string>();

  for (const file of candidates) {
    if (seenInBatch.has(file.contentHash)) {
      plan.skippedDuplicateInBatch.push(file);
      continue;
    }
    seenInBatch.add(file.contentHash);

    if (existingHashes.has(file.contentHash) || existingNameSize.has(`${file.fileName} ${file.fileSize}`)) {
      plan.skippedExisting.push(file);
      continue;
    }
    plan.toUpload.push(file);
  }
  return plan;
};
