import { ISessionDocument } from '@bike4mind/common';

/**
 * Shared sidebar list item types, extracted from CombinedNotebooks so the row and
 * list components can share them without importing back into the parent.
 */
export interface CombinedSessionDocument extends ISessionDocument {
  isShared?: boolean;
  isProject?: boolean;
  isAgent?: boolean;
}

export type CombinedItem =
  | CombinedSessionDocument
  | {
      id: string;
      name: string;
      isProject: boolean;
      lastUpdated: Date;
      firstCreated: Date;
      description?: string;
      [key: string]: any;
    }
  | {
      id: string;
      name: string;
      isAgent: boolean;
      lastUpdated: Date;
      firstCreated: Date;
      triggerWords: string[];
      visual?: any;
    };
