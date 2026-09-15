import { ElabsEvents } from '@bike4mind/common';
import { Voice } from '@bike4mind/database';
import { logEvent } from '@server/utils/analyticsLog';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';

const handler = baseApi()
  /**
   * Delete a voice id
   */
  .delete(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const userId = req.user?.id;
      const id = req.query.id!;

      const deletedApiKey = await Voice.findOneAndDelete({ _id: id, userId });

      await logEvent({ userId, type: ElabsEvents.DELETE_ELABS_VOICE, metadata: { id } }, { ability: req.ability });

      return res.status(200).json(deletedApiKey);
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
