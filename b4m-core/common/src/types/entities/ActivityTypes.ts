import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

export interface IActivity {
  key: string; // The type of activity (e.g., memento.create)
  trackableType: string; // The model name of the tracked item
  trackableId: string; // The ID of the tracked item
  ownerType: string; // The model name of the owner (usually User)
  ownerId: string; // The ID of the owner
  receiverId?: string;
  receiverType?: string;
  ownerName: string; // The name of the owner
  trackableName?: string; // The name of the tracked item
  receiverName?: string;
  message?: string; // The message associated with the activity
  createdAt: Date; // When the activity was created
  parameters?: Record<string, string>; // Additional parameters
}

export interface IActivityDocument extends IActivity, IMongoDocument {}

export interface IActivityRepository extends IBaseRepository<IActivityDocument> {
  createActivity: (
    key: string,
    trackable: { type: string; id: string },
    owner: { type: string; id: string },
    receiver?: { type: string; id: string }
  ) => Promise<IActivityDocument>;
  findByTrackable: (trackableType: string, trackableId: string) => Promise<IActivityDocument[]>;
  findByOwner: (ownerType: string, ownerId: string) => Promise<IActivityDocument[]>;
}
