import { IBaseEvent } from '../../../types';

export enum CurationEvents {
  NOTEBOOK_CURATED = 'Notebook Curated',
  CURATION_STARTED = 'Curation Started',
  CURATION_FAILED = 'Curation Failed',
}

export interface INotebookCuratedEvent extends IBaseEvent {
  type: CurationEvents.NOTEBOOK_CURATED;
  metadata: {
    /** ID of the session that was curated */
    sessionId: string;
    /** ID of the curation job */
    curationJobId: string;
    /** ID of the generated file */
    curatedFileId: string;
    /** Type of curation performed */
    curationType: 'transcript' | 'executive_summary';
    /** Export format used */
    exportFormat: 'markdown' | 'txt' | 'html';
    /** Number of artifacts included */
    artifactCount: number;
    /** Number of messages curated */
    messageCount: number;
    /** Tokens processed during curation */
    tokensProcessed: number;
    /** Artifact types included in curation */
    artifactTypes?: string[];
    /** File extension of the curated file */
    fileExtension?: string;
    /** MIME type of the curated file */
    mimeType?: string;
    /** File size in bytes */
    fileSize?: number;
    /** File name */
    fileName?: string;
  };
}

export interface ICurationStartedEvent extends IBaseEvent {
  type: CurationEvents.CURATION_STARTED;
  metadata: {
    /** ID of the session being curated */
    sessionId: string;
    /** ID of the curation job */
    curationJobId: string;
    /** Type of curation requested */
    curationType: 'transcript' | 'executive_summary';
    /** Export format requested */
    exportFormat: 'markdown' | 'txt' | 'html';
    /** Batch job ID if part of a batch */
    batchJobId?: string;
    /** Batch index if part of a batch */
    batchIndex?: number;
    /** Total batch size if part of a batch */
    batchTotal?: number;
  };
}

export interface ICurationFailedEvent extends IBaseEvent {
  type: CurationEvents.CURATION_FAILED;
  metadata: {
    /** ID of the session that failed to curate */
    sessionId: string;
    /** ID of the curation job */
    curationJobId: string;
    /** Error message */
    error: string;
    /** Stage where the error occurred */
    stage: string;
  };
}

export type CurationEventPayload = INotebookCuratedEvent | ICurationStartedEvent | ICurationFailedEvent;
