import { IActivityDocument, IActivityRepository } from '@bike4mind/common';
import mongoose, { Schema, Model, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import { projectRepository } from './ProjectModel';

export interface IActivityModel extends Model<IActivityDocument> {
  createActivity: (
    key: string,
    trackable: { type: string; id: string },
    owner: { type: string; id: string },
    receiver?: { type: string; id: string }
  ) => Promise<IActivityDocument>;
  findByTrackable: (trackableType: string, trackableId: string) => Promise<IActivityDocument[]>;
  findByOwner: (ownerType: string, ownerId: string) => Promise<IActivityDocument[]>;
  findUserFeed: (userId: string) => Promise<IActivityDocument[]>;
}

class ActivityRepository extends BaseRepository<IActivityDocument> implements IActivityRepository {
  constructor(model: IActivityModel) {
    super(model);
  }

  async createActivity(
    key: string,
    trackable: { type: string; id: string },
    owner: { type: string; id: string },
    receiver?: { type: string; id: string }
  ) {
    const ownerData = await mongoose.model(owner.type).findById(owner.id);
    const trackableData = await mongoose.model(trackable.type).findById(trackable.id);
    const receiverData = receiver ? await mongoose.model(receiver.type).findById(receiver.id) : undefined;

    return this.model.create({
      key,
      trackableType: trackable.type,
      trackableId: trackable.id,
      ownerType: owner.type,
      ownerId: owner.id,
      receiverType: receiver?.type,
      receiverId: receiver?.id,
      ownerName: ownerData.name,
      trackableName: trackableData?.name,
      receiverName: receiverData?.name,
      createdAt: new Date(),
    });
  }

  async findByTrackable(trackableType: string, trackableId: string) {
    return this.model
      .find({
        trackableType: trackableType,
        trackableId: trackableId,
      })
      .sort({ createdAt: -1 });
  }

  async findByOwner(ownerType: string, ownerId: string) {
    return this.model
      .find({
        ownerType: ownerType,
        ownerId: new mongoose.Types.ObjectId(ownerId),
      })
      .sort({ createdAt: -1 });
  }

  async findUserFeed(userId: string, projectFilter: Record<string, unknown> = {}, skip = 0, limit = 10) {
    const userProjects = await projectRepository.find(projectFilter);

    // Filter out projects with null _id to prevent toString() errors
    const projectIds = userProjects.filter(project => project._id != null).map(project => project._id.toString());

    const query = {
      $or: [
        { ownerType: 'User', ownerId: userId },
        { trackableType: 'Project', trackableId: { $in: projectIds } },
      ],
    };

    const activities = await this.model.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit);

    const totalCount = await this.model.countDocuments(query);

    return {
      activities,
      totalCount,
    };
  }
}

const ActivitySchema = new Schema<IActivityDocument, IActivityModel>(
  {
    key: {
      type: String,
      required: true,
    },
    trackableType: {
      type: String,
      required: true,
      index: true,
    },
    trackableId: {
      type: String,
      required: true,
      index: true,
    },
    ownerType: {
      type: String,
      index: true,
    },
    ownerId: {
      type: String,
      index: true,
    },
    ownerName: {
      type: String,
      index: true,
    },
    trackableName: {
      type: String,
      index: true,
    },
    receiverName: {
      type: String,
      index: true,
    },
    parameters: {
      type: Schema.Types.Mixed,
      default: {},
    },
    createdAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret: any) => {
        delete ret._id;
      },
    },
    toObject: {
      virtuals: true,
      transform: (_doc, ret: any) => {
        delete ret._id;
      },
    },
  }
);

interface IActivityMethods {}

export interface IActivityObject extends IActivityDocument, Omit<Document, 'id'>, IActivityMethods {}

const Activity =
  (mongoose.models.Activity as IActivityModel) ?? model<IActivityDocument, IActivityModel>('Activity', ActivitySchema);

export const activityRepository = new ActivityRepository(Activity);

export default Activity;
