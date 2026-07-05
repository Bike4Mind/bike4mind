import { IBaseRepository } from './BaseTypes';
import { IShareableStaticMethods } from './ShareableDocumentTypes';
import { BaseArtifact, ReactArtifactV2, HtmlArtifactV2, SvgArtifactV2, MermaidArtifactV2 } from './ArtifactTypes';
import { QuestMasterArtifactV2 } from './QuestMasterArtifactTypes';

// Document interfaces for MongoDB integration
export interface IArtifactDocument extends BaseArtifact {
  _id: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IArtifactContentDocument {
  _id: string;
  artifactId: string;
  version: number;
  content: string;
  contentHash: string;
  contentSize: number;
  mimeType?: string;
  encoding?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IArtifactVersionDocument {
  _id: string;
  artifactId: string;
  version: number;
  versionTag?: string;
  contentId: string;
  parentVersionId?: string;
  changes: string[];
  changeDescription?: string;
  createdBy: string;
  createdAt: Date;
  isActive: boolean;
}

export interface IQuestMasterArtifactDocument extends QuestMasterArtifactV2 {
  _id: string;
  createdAt: Date;
  updatedAt: Date;
}

// Repository interfaces following the established pattern
export interface IArtifactRepository extends IBaseRepository<IArtifactDocument> {
  shareable: IShareableStaticMethods<IArtifactDocument>;

  // Artifact-specific methods
  findByType(type: string, filter?: Record<string, unknown>): Promise<IArtifactDocument[]>;
  findByUser(userId: string, filter?: Record<string, unknown>): Promise<IArtifactDocument[]>;
  findByProject(projectId: string, filter?: Record<string, unknown>): Promise<IArtifactDocument[]>;
  findBySession(sessionId: string, filter?: Record<string, unknown>): Promise<IArtifactDocument[]>;
  findActive(filter?: Record<string, unknown>): Promise<IArtifactDocument[]>;
  findByStatus(status: string, filter?: Record<string, unknown>): Promise<IArtifactDocument[]>;
  findByVisibility(visibility: string, filter?: Record<string, unknown>): Promise<IArtifactDocument[]>;
  searchByText(searchTerm: string, filter?: Record<string, unknown>): Promise<IArtifactDocument[]>;
  findDuplicatesByHash(contentHash: string): Promise<IArtifactDocument[]>;

  // Permission-based queries
  findByUserWithAccess(userId: string, accessType?: 'read' | 'write' | 'delete'): Promise<IArtifactDocument[]>;

  // Soft delete support
  softDelete(id: string): Promise<boolean>;
  restore(id: string): Promise<boolean>;
  findDeleted(filter?: Record<string, unknown>): Promise<IArtifactDocument[]>;
}

export interface IArtifactContentRepository extends IBaseRepository<IArtifactContentDocument> {
  // Content-specific methods
  findByArtifactId(artifactId: string): Promise<IArtifactContentDocument[]>;
  findByArtifactVersion(artifactId: string, version: number): Promise<IArtifactContentDocument | null>;
  findByHash(contentHash: string): Promise<IArtifactContentDocument[]>;
  findLatestContent(artifactId: string): Promise<IArtifactContentDocument | null>;

  // Content management
  createVersion(
    artifactId: string,
    version: number,
    content: string,
    contentHash: string
  ): Promise<IArtifactContentDocument>;
  createOrUpdate(
    data: Omit<IArtifactContentDocument, 'id' | '_id' | 'updatedAt' | 'createdAt'>
  ): Promise<IArtifactContentDocument>;
  getContentSize(artifactId: string, version?: number): Promise<number>;
}

export interface IArtifactVersionRepository extends IBaseRepository<IArtifactVersionDocument> {
  // Version-specific methods
  findByArtifactId(artifactId: string): Promise<IArtifactVersionDocument[]>;
  findActiveVersion(artifactId: string): Promise<IArtifactVersionDocument | null>;
  findByUser(userId: string): Promise<IArtifactVersionDocument[]>;
  getVersionHistory(artifactId: string): Promise<IArtifactVersionDocument[]>;

  // Version management
  createVersion(
    artifactId: string,
    version: number,
    contentId: string,
    createdBy: string,
    changes?: string[],
    changeDescription?: string,
    parentVersionId?: string
  ): Promise<IArtifactVersionDocument>;
  createOrUpdate(
    data: Omit<IArtifactVersionDocument, 'id' | '_id' | 'updatedAt' | 'createdAt'>
  ): Promise<IArtifactVersionDocument>;
  setActiveVersion(artifactId: string, version: number): Promise<boolean>;
  getLatestVersion(artifactId: string): Promise<number>;
}

export interface IQuestMasterArtifactRepository extends IBaseRepository<IQuestMasterArtifactDocument> {
  shareable: IShareableStaticMethods<IQuestMasterArtifactDocument>;

  // QuestMaster-specific methods
  findByComplexity(
    complexity: 'beginner' | 'intermediate' | 'advanced' | 'expert'
  ): Promise<IQuestMasterArtifactDocument[]>;
  findByProgress(minCompletion: number, maxCompletion?: number): Promise<IQuestMasterArtifactDocument[]>;
  findWithAvailableQuests(userId: string): Promise<IQuestMasterArtifactDocument[]>;

  // Quest management
  updateQuestStatus(
    artifactId: string,
    questId: string,
    status: 'not_started' | 'in_progress' | 'completed' | 'blocked'
  ): Promise<boolean>;
  completeQuest(artifactId: string, questId: string): Promise<boolean>;
  getNextAvailableQuest(artifactId: string): Promise<string | null>;
  calculateProgress(artifactId: string): Promise<{ totalQuests: number; completedQuests: number; percentage: number }>;

  // Search
  searchByQuestContent(searchTerm: string): Promise<IQuestMasterArtifactDocument[]>;
  findByTags(tags: string[]): Promise<IQuestMasterArtifactDocument[]>;
}

// Type-specific artifact repositories for future extension
export interface IReactArtifactRepository extends IBaseRepository<ReactArtifactV2> {
  // React-specific methods can be added here
}

export interface IHtmlArtifactRepository extends IBaseRepository<HtmlArtifactV2> {
  // HTML-specific methods can be added here
}

export interface ISvgArtifactRepository extends IBaseRepository<SvgArtifactV2> {
  // SVG-specific methods can be added here
}

export interface IMermaidArtifactRepository extends IBaseRepository<MermaidArtifactV2> {
  // Mermaid-specific methods can be added here
}
