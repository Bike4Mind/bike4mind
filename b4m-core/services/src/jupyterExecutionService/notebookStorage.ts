/**
 * Notebook Storage Service
 *
 * Handles persistence of executed Jupyter notebooks as FabFiles
 * for download, sharing, and knowledge base integration.
 */

import { Logger } from '@bike4mind/observability';
import { BaseStorage } from '@bike4mind/utils';
import { IFabFileRepository, KnowledgeType } from '@bike4mind/common';
import { NotebookDocument, serializeNotebook } from '../llm/tools/implementation/jupyterNotebook/notebookStructure';

/**
 * Adapters required by the notebook storage service
 */
export interface NotebookStorageAdapters {
  /** FabFile repository for creating file records */
  fabFileRepository: IFabFileRepository;
  /** Storage backend for uploading files */
  storage: Pick<BaseStorage, 'upload'>;
  /** Logger */
  logger: Logger;
}

/**
 * Metadata for a stored notebook
 */
export interface NotebookMetadata {
  /** Name of the notebook (without extension) */
  name: string;
  /** Jupyter kernel used for execution */
  kernelName: string;
  /** Number of cells in the notebook */
  cellCount: number;
  /** Execution time in milliseconds */
  executionTime: number;
  /** Analysis description that generated this notebook */
  analysisDescription?: string;
  /** Quest ID that generated this notebook */
  questId?: string;
}

/**
 * Result of storing a notebook
 */
export interface StoreNotebookResult {
  /** FabFile ID of the stored notebook */
  fabFileId: string;
  /** Storage path of the notebook */
  storagePath: string;
  /** Size of the notebook in bytes */
  fileSize: number;
}

/**
 * Notebook Storage Service
 *
 * Saves executed Jupyter notebooks as FabFiles for persistence and sharing.
 */
export class NotebookStorageService {
  private adapters: NotebookStorageAdapters;

  constructor(adapters: NotebookStorageAdapters) {
    this.adapters = adapters;
  }

  /**
   * Save an executed notebook as a FabFile
   */
  async saveExecutedNotebook(
    userId: string,
    sessionId: string,
    notebook: NotebookDocument,
    metadata: NotebookMetadata
  ): Promise<StoreNotebookResult> {
    const { logger, fabFileRepository, storage } = this.adapters;

    // Serialize notebook to JSON
    const content = serializeNotebook(notebook);
    const fileSize = Buffer.byteLength(content, 'utf-8');
    const fileName = `${metadata.name}.ipynb`;

    // Generate storage path
    const timestamp = Date.now();
    const storagePath = `notebooks/${userId}/${sessionId}/${timestamp}_${fileName}`;

    logger.info(`[NotebookStorage] Saving notebook to ${storagePath} (${fileSize} bytes)`);

    // Upload to storage
    await storage.upload(content, storagePath, {
      ContentType: 'application/x-ipynb+json',
      Metadata: {
        kernelName: metadata.kernelName,
        cellCount: String(metadata.cellCount),
        executionTime: String(metadata.executionTime),
        ...(metadata.questId && { questId: metadata.questId }),
      },
    });

    // Create FabFile record
    // Note: Additional notebook metadata (kernelName, cellCount, etc.) is stored
    // in the S3 object metadata above
    const fabFile = await fabFileRepository.create({
      userId,
      fileName,
      fileSize,
      mimeType: 'application/x-ipynb+json',
      filePath: storagePath,
      type: KnowledgeType.FILE,
      status: 'complete',
      sessionId,
      // Shareable document defaults - notebook is private by default
      isGlobalRead: false,
      isGlobalWrite: false,
      users: [],
      groups: [],
    });

    logger.info(`[NotebookStorage] Created FabFile ${fabFile.id} for notebook`);

    return {
      fabFileId: fabFile.id,
      storagePath,
      fileSize,
    };
  }
}

/**
 * Create a NotebookStorageService with the given adapters
 */
export function createNotebookStorageService(adapters: NotebookStorageAdapters): NotebookStorageService {
  return new NotebookStorageService(adapters);
}
