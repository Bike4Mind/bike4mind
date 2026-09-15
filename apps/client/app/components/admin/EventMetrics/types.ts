export interface EventMetric {
  id: string;
  timestamp: string;
  eventName: string;
  eventCategory: string;
  user: {
    userId: string;
    userName: string;
    userLevel: string;
    userOrganization?: string;
    userTags?: string[];
  };
  counterValue: number;
  metadata?: Record<string, any>;
}

export interface CurationMetadata {
  curationType?: 'transcript' | 'executive_summary';
  exportFormat?: 'markdown' | 'txt' | 'html';
  artifactTypes?: string[];
  mimeType?: string;
  fileExtension?: string;
  fileSize?: number;
  fileName?: string;
}

export type SortField = 'timestamp' | 'eventName' | 'eventCategory' | 'userName' | 'counterValue';

export type SortDirection = 'asc' | 'desc';
