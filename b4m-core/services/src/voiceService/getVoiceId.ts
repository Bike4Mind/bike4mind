import { IVoice } from '@bike4mind/common';

interface GetVoiceIdAdapters {
  db: {
    voices: {
      findActiveByUserId: (userId: string) => Promise<IVoice | null>;
    };
  };
}

/**
 * Returns the user's active ElevenLabs voice id, or null when none is set.
 */
export const getVoiceId = async (userId: string, { db }: GetVoiceIdAdapters): Promise<string | null> => {
  const record = await db.voices.findActiveByUserId(userId);
  return record ? record.voiceId : null;
};
