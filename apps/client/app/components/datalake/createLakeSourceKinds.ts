import type { DataLakeOrigin } from '@bike4mind/common';

export type CreateLakeSourceKind = 'upload' | 'googleDrive' | 'github';

const CREATE_LAKE_ORIGINS: Record<CreateLakeSourceKind, DataLakeOrigin> = {
  upload: 'curated',
  googleDrive: 'connector-fed',
  github: 'connector-fed',
};

export const createLakeOrigin = (kind: CreateLakeSourceKind): DataLakeOrigin => CREATE_LAKE_ORIGINS[kind];

export const createSourceRequiresUpload = (kind: CreateLakeSourceKind): boolean => kind === 'upload';
