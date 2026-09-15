import { IAppFileDocument } from './AppFileTypes';

export interface IDashboardTile {
  /**
   * Unique identifier for the dashboard tile
   */
  staticId: string;
  description?: string;
  /**
   * Associated Dashboard Report(AppFile) ID
   */
  reportId?: string | null;
  /** Suggested questions for the dashboard tile data */
  suggestedQuestions?: string[];
}

export interface IDashboardTileWithReport extends Omit<IDashboardTile, 'reportId'> {
  reportId: IAppFileDocument;
}
