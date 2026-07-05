import { IMongoDocument } from '.';
import { ICounter } from './CounterTypes';
import { VariantContent } from './AudienceVariantTypes';

export interface ModalImage {
  url: string;
  width?: number;
  height?: number;
}

/**
 * Generation metadata for auto-generated modals (e.g., What's New).
 * Only populated for modals created by automated workflows.
 * Null/undefined for manually created modals and banners.
 */
export interface IGenerationMetadata {
  /** Date for daily batch generation (YYYY-MM-DD format) */
  generatedDate?: string;
  /** Array of release tags included in this modal */
  releases?: string[];
  /** Single release tag (backward compatibility) */
  releaseTag?: string;
  /** Correlation ID for tracing the generation request */
  correlationId: string;
  /** LLM model used for generation */
  modelUsed: string;
  /** Environment where the modal was generated */
  environment: 'dev' | 'production';
  /** Timestamp when the modal was generated */
  generatedAt: Date;
  /** Source modal ID from production (for fork-imported modals) */
  sourceModalId?: string;
  /** Origin of the modal - 'production' for imported, 'self' for locally generated */
  importedFrom?: 'production' | 'self';
  /** Content hash from production S3 at time of import (for edit detection during sync) */
  sourceContentHash?: string;
  /** Timestamp when the modal was last synced from production */
  lastSyncedAt?: Date;
}

export interface IModal {
  _id?: string | null;
  isBanner: boolean | false;
  title: string | null;
  subtitle: string | null;
  description: string | null; // markdown content
  tags: Array<string> | null;
  priority: number | 0;
  closeButton: boolean | true;
  agreeButton: boolean | false;
  enabled: boolean | true;
  startDate: string | null;
  endDate: string | null;
  numberOfAgrees: ICounter | null;
  numberOfViews: ICounter | null;
  imageUrl: string | null;
  images?: ModalImage[] | null;
  textMessage: string | null;
  /** Generation metadata for auto-generated modals (null for manual modals) */
  generationMetadata?: IGenerationMetadata | null;
  /**
   * Per-audience variant content. Keys are AudienceKey values ('internal' | 'customer').
   * Stripped at serve time - never appears in a serving-endpoint response body.
   * Absent on legacy / non-variant modals.
   */
  variants?: Partial<Record<string, VariantContent>> | null;
}

export interface IModalDocument extends IModal, IMongoDocument {}
