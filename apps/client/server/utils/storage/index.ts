import { S3Storage } from '@bike4mind/fab-pipeline';
import { Resource } from 'sst';

let _filesStorage: S3Storage | undefined;
let _generatedImageStorage: S3Storage | undefined;
let _publishedArtifactsStorage: S3Storage | undefined;

export const getFilesStorage = () => {
  if (!_filesStorage) _filesStorage = new S3Storage(Resource.fabFileBucket.name);
  return _filesStorage;
};

export const getGeneratedImageStorage = () => {
  if (!_generatedImageStorage) _generatedImageStorage = new S3Storage(Resource.generatedImagesBucket.name);
  return _generatedImageStorage;
};

export const getPublishedArtifactsStorage = () => {
  if (!_publishedArtifactsStorage) {
    _publishedArtifactsStorage = new S3Storage(Resource.publishedArtifactsBucket.name);
  }
  return _publishedArtifactsStorage;
};
