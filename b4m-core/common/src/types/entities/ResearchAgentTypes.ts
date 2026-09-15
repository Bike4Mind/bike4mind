import { IBaseRepository } from './BaseTypes';

export interface IResearchAgent {
  /**
   * The unique identifier for the research agent
   */
  id: string;

  /**
   * The name of the research agent
   */
  name: string;
  /**
   * The description of the research agent
   */
  description: string;
  /**
   * The unique identifier for the user who created the research agent
   */
  userId: string;
  /**
   * The date and time the research agent was created
   */
  createdAt: Date;
  /**
   * The date and time the research agent was last updated
   */
  updatedAt: Date;
  /**
   * The date and time the research agent was deleted
   */
  deletedAt?: Date;
}

export interface IResearchAgentRepository extends IBaseRepository<IResearchAgent> {
  /**
   * Find a research agent by its unique identifier and the user who created it
   */
  findByIdAndUserId: (id: string, userId: string) => Promise<IResearchAgent | null>;
  /**
   * Find all research agents by the user who created them
   */
  findAllByUserId: (userId: string) => Promise<IResearchAgent[]>;
}
