import { IVoice } from '@bike4mind/common';
import { obfuscateApiKey } from '@bike4mind/utils';
import BaseRepository from '@bike4mind/db-core';
import mongoose from 'mongoose';
import { softDeletePlugin } from '../../utils/mongo';

const VoiceSchema = new mongoose.Schema<IVoice>(
  {
    userId: { type: String, required: true },
    voiceId: { type: String, required: true },
    description: { type: String },
    isActive: { type: Boolean, required: true },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret: any) => {
        // Obfuscate the API key before sending it to the client
        ret.apiKey = obfuscateApiKey(ret.apiKey);
      },
    },
    toObject: {
      virtuals: true,
    },
  }
);

VoiceSchema.plugin(softDeletePlugin);

export const Voice: mongoose.Model<IVoice> = mongoose.models.Voice ?? mongoose.model<IVoice>('Voice', VoiceSchema);
export default Voice;

export class VoiceRepository extends BaseRepository<IVoice> {
  findActiveByUserId(userId: string) {
    return this.model.findOne({ userId, isActive: true }).exec();
  }
}

export const voiceRepository = new VoiceRepository(Voice);
