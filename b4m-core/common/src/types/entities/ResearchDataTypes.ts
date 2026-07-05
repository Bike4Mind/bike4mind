import { IBaseRepository } from './BaseTypes';
import { IFabFileDocument } from './FabFileTypes';

export type IResearchDataMetaData = {
  /**
   * The url of the research data
   */
  url?: string;
  [key: string]: unknown;
};

export interface IResearchData {
  id: string;

  /**
   * The id of the research task
   */
  researchTaskId: string;
  /**
   * The id of the research agent
   */
  researchAgentId: string;
  /**
   * The id of the fab file
   */
  fabFileId: string;

  /**
   * The id of the organization
   */
  organizationId?: string;

  /**
   * The id of the user owning the research data
   */
  userId?: string;

  url?: string;

  metaData?: IResearchDataMetaData;

  createdAt: Date;
  updatedAt: Date;
}

export interface IResearchDataWithFiles extends IResearchData {
  fabFile: IFabFileDocument;
}

export interface IResearchDataRepository extends IBaseRepository<IResearchData> {
  /**
   * Find all research data by research task id
   * @param researchTaskId - The id of the research task
   * @returns The research data
   */
  findAllByResearchTaskId(researchTaskId: string): Promise<IResearchData[]>;

  /**
   * Find all research data by research agent id
   */
  findAllByResearchAgentId(researchAgentId: string): Promise<IResearchData[]>;

  /**
   * Delete all research data by research task id
   */
  deleteAllByResearchTaskId(researchTaskId: string): Promise<void>;

  /**
   * Find Research Data by research agent id and research task id
   */
  findByResearchAgentIdAndResearchTaskId(
    researchAgentId: string,
    researchTaskId: string
  ): Promise<IResearchData | null>;

  /**
   * Find all research data by research task id with files
   * @param researchTaskId - The id of the research task
   * @returns The research data with files
   */
  findAllByResearchTaskIdWithFiles(researchTaskId: string): Promise<IResearchDataWithFiles[]>;

  /**
   * Find Research Data by id and research agent id
   * @param id - The id of the research data
   * @param researchAgentId - The id of the research agent
   */
  findByIdAndResearchAgentId(id: string, researchAgentId: string): Promise<IResearchData | null>;

  /**
   * Find Research Data by metadata url and organization id
   * @param url - The url of the research data
   * @param organizationId - The id of the organization
   */
  findByMetadataUrlAndOrganizationId(url: string, organizationId: string): Promise<IResearchData | null>;

  /**
   * Find Research Data by metadata url
   * @param url - The url of the research data
   * @param userId - The id of the user
   */
  findByMetadataUrlAndUserId(url: string, userId: string): Promise<IResearchData | null>;

  /**
   * Find Research Data by url and user id
   * @param url - The url of the research data
   * @param userId - The id of the user
   */
  findByUrlAndUserId(url: string, userId: string): Promise<IResearchData | null>;

  /**
   * Find Research Data by url and organization id
   * @param url - The url of the research data
   * @param organizationId - The id of the organization
   */
  findByUrlAndOrganizationId(url: string, organizationId: string): Promise<IResearchData | null>;

  /**
   * Exists Research Data by url and research task id
   * @param url - The url of the research data
   * @param researchTaskId - The id of the research task
   */
  existsByUrlAndResearchTaskId(url: string, researchTaskId: string): Promise<boolean>;
}
