import { ElabsEvents } from '@bike4mind/common';
import { Voice } from '@bike4mind/database';
import { logEvent } from '@server/utils/analyticsLog';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { z } from 'zod';

// This api finds all voice id for user
const handler = baseApi()
  /**
   * Get all voice ids for the user
   */
  .get(
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;

      const apiKeys = await Voice.find({ userId });
      return res.json(apiKeys);
    })
  )
  /**
   * Create a new voice id
   */
  .post(
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;

      const validatedBody = z
        .object({
          keySpec: z.string().min(6),
          description: z.string().optional().prefault(''),
          isActive: z.boolean().optional().prefault(true),
        })
        .parse(req.body);

      const { keySpec: voiceId, description, isActive } = validatedBody;

      // If the new key is to be active, deactivate all other keys
      if (isActive) {
        await Voice.updateMany({ userId, isActive: true }, { isActive: false });
      }

      const newVoice = await Voice.create({ userId, voiceId, description, isActive });

      await logEvent(
        { userId, type: ElabsEvents.CREATE_ELABS_VOICE, metadata: { id: newVoice.id } },
        { ability: req.ability }
      );

      return res.status(200).json(newVoice);
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
