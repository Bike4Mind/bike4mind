/*
 * Dexie database definitions
 *
 * Helpful docs:
 * - https://dexie.org/docs/Tutorial/Understanding-the-basics
 */

import {
  IUser,
  ISessionDocument,
  IFabFileDocument,
  IAdminSettings,
  IChatHistoryItem,
  IAppFile,
  IQuestMasterPlanDocument,
  IArtifactDocument,
  IArtifactVersionDocument,
} from '@bike4mind/common';
import { IUserSubscription } from '@client/lib/userSubscriptions/types';
import Dexie, { Table } from 'dexie';

export class DexieStore extends Dexie {
  public users!: Table<IUser, string>;
  public sessionmodels!: Table<ISessionDocument, string>;
  public fabfiles!: Table<IFabFileDocument, string>;
  public adminsettings!: Table<IAdminSettings, string>;
  public quests!: Table<IChatHistoryItem, string>;
  appfiles!: Table<IAppFile, string>;
  usersubscriptions!: Table<IUserSubscription, string>;
  questmasterplans!: Table<IQuestMasterPlanDocument, string>;
  artifacts!: Table<IArtifactDocument, string>;
  artifact_versions!: Table<IArtifactVersionDocument, string>;

  /*
  The order of the keys matter, first must be unique keys.
  The first one listed in each (_id) is primary key, it's always unique.
  After that we list secondary indexes; & means unqiue as well.
  Note: so userId is a non-unique secondary index.
  (If userId is listed first, will cause a runtime error because it changes the primary key for the database)
  */
  /*
   * These should match the collection names, e.g. 'sessionmodels' for SessionModel.  Also
   * check that it's been added (usually via variable name) to dataSubscribeRequest.ts
   */

  // You must bump the version number when you change this or you will get a vague error:
  // About Table not found
  constructor() {
    super('Bike4Mind');
    // DID YOU BUMP THE VERSION NUMBER?
    // JUST GO AHEAD AND BUMP THE VERSION NUMBER
    this.version(20).stores({
      users: '_id, &id',
      sessionmodels: '_id, &id, userId, lastUpdated',
      toolmodels: '_id, &id, userId',
      fabfiles: '_id, &id, userId, isChunk',
      inboxes: '_id, &id, receiverId',
      invites: '_id, &id, *recipients.pending',
      quests: '_id, &id, sessionId',
      appfiles: '_id, &id',
      projects: '_id, &id',
      usersubscriptions: '_id, &id, userId',
      questmasterplans: '_id, &id, notebookId',
      artifacts: '_id, &id, userId, type, status, sessionId, projectId',
      artifact_versions: '_id, &id, artifactId, version, createdBy',

      adminsettings: '_id, &id, &name',
    });
  }
}

export const dexie = new DexieStore();
