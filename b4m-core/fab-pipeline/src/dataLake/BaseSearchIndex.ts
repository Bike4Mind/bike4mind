import { parallelLimit } from '@bike4mind/common';
import { SearchDocument } from './config';
import { OpenSearchClient } from './opensearchClient';
import { Logger } from '@bike4mind/observability';
export abstract class BaseSearchIndex {
  protected document: SearchDocument | null = null;
  protected searchIndexName: string;

  constructor(
    public rawData: any,
    searchIndexName: string
  ) {
    this.searchIndexName = searchIndexName;
  }

  static async reindex(logger: Logger, queueUrl?: string): Promise<SearchDocument[]> {
    throw new Error('reindex() method must be implemented by subclass');
  }

  static async loadSearchIndexClient(): Promise<OpenSearchClient> {
    throw new Error('loadSearchIndexClient() method must be implemented by subclass');
  }

  protected static async deleteBySourceType(sourceType: string, searchIndexName: string): Promise<void> {
    const osClient = await this.loadSearchIndexClient();
    try {
      await osClient.deleteDocumentByQuery(searchIndexName, {
        query: {
          term: {
            'metadata.sourceType': sourceType,
          },
        },
      });
      Logger.globalInstance.info(`Deleted existing ${sourceType} documents`);
    } catch (error) {
      Logger.globalInstance.warn(`Failed to delete existing ${sourceType} documents:`, error);
    }
  }

  async addDocument(): Promise<SearchDocument | null> {
    const document = await this.loadDocument();
    const osClient = await (this.constructor as typeof BaseSearchIndex).loadSearchIndexClient();

    if (!document) return null;
    try {
      await osClient.indexDocument(this.searchIndexName, document);
      Logger.globalInstance.info(`Indexed vector chunk ${document.id} for ${this.constructor.name}`);
      return document;
    } catch (error) {
      Logger.globalInstance.error(`Failed to index vector chunk ${document.id} for ${this.constructor.name}:`, error);
      throw error;
    }
  }

  protected static async processInParallel<T extends BaseSearchIndex>(
    vectorChunks: T[],
    concurrency: number = 20
  ): Promise<SearchDocument[]> {
    return await parallelLimit<any, SearchDocument>(vectorChunks, concurrency, async chunk => {
      return await chunk.addDocument();
    });
  }

  protected abstract mapDocument(data: any): Promise<SearchDocument | null>;

  async loadDocument(): Promise<SearchDocument | null> {
    if (!this.document) {
      this.document = await this.mapDocument(this.rawData);
    }
    return this.document;
  }

  static async ensureIndex(searchIndexName: string, indexSettings: Record<string, any>): Promise<void> {
    const osClient = await this.loadSearchIndexClient();
    Logger.globalInstance.log('ensureIndex', searchIndexName);
    const exists = await osClient.indexExists(searchIndexName);

    if (!exists) {
      await osClient.createIndex(searchIndexName, indexSettings);
    }
  }
}
