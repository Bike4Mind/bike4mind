import { IBaseEvent } from '../../../types';

export enum FileEvents {
  CREATE_FILE = 'File Created',
  FILE_UPLOADED = 'File Uploaded',
  FILE_DOWNLOADED = 'File Downloaded',
  CREATE_FILE_URL = 'File URL Created',
  DELETE_FILE = 'File Deleted',
  DELETE_ALL_FILES = 'All Files Deleted',
  UPDATE_FILE = 'File Updated',
  GENERATE_FILE_PRESIGNED_URL = 'File Presigned URL Generated',
  UNSHARE_FILE = 'File Unshared',
}

export interface ICreateFileEvent extends IBaseEvent {
  type: FileEvents.CREATE_FILE;
  metadata: {
    /** ID of the file that was created */
    fileId: string;
  };
}

interface IFileUploadedEvent extends IBaseEvent {
  type: FileEvents.FILE_UPLOADED;
  metadata: {
    /** ID of the file that was created */
    fileId: string;
    fileSize: number;
    mimeType: string;
  };
}

interface IFileDownloadedEvent extends IBaseEvent {
  type: FileEvents.FILE_DOWNLOADED;
  metadata: {
    /** ID of the file that was downloaded */
    fileId: string;
  };
}

interface ICreateFileUrlEvent extends IBaseEvent {
  type: FileEvents.CREATE_FILE_URL;
  metadata: {
    /** ID of the file that was created */
    fileId: string;
    fileSize: number;
    mimeType: string;
    /** URL that was used to create the file */
    fileUrl: string;
  };
}

interface IDeleteFileEvent extends IBaseEvent {
  type: FileEvents.DELETE_FILE;
  metadata: {
    /** ID of the file that was deleted */
    fileId: string;
  };
}

interface IDeleteAllFilesEvent extends IBaseEvent {
  type: FileEvents.DELETE_ALL_FILES;
  metadata: {
    /** Number of files deleted */
    fileCount: number;
  };
}

export interface IUpdateFileEvent extends IBaseEvent {
  type: FileEvents.UPDATE_FILE;
  metadata: {
    /** ID of the file that was updated */
    fileId: string;
    /** New content of the file */
    fileContent: string;
  };
}

interface IUnshareFileEvent extends IBaseEvent {
  type: FileEvents.UNSHARE_FILE;
  metadata: {
    /** ID of the file the user unshared from */
    fileId: string;
    /** ID of the file owner */
    ownerId: string;
  };
}

interface IGenerateFilePresignedUrlEvent extends IBaseEvent {
  type: FileEvents.GENERATE_FILE_PRESIGNED_URL;
  metadata: {
    /** ID of the file which a presigned URL was generated for */
    id: string;
    /** The presigned URL */
    url: string;
    /** The expiry time of the presigned URL */
    expiry: number;
  };
}

export type FileEventPayload =
  | ICreateFileEvent
  | IFileUploadedEvent
  | IFileDownloadedEvent
  | IDeleteFileEvent
  | ICreateFileUrlEvent
  | IDeleteAllFilesEvent
  | IUpdateFileEvent
  | IUnshareFileEvent
  | IGenerateFilePresignedUrlEvent;
