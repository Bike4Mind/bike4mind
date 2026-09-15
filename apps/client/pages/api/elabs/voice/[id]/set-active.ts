import { ElabsEvents } from '@bike4mind/common';
import { Voice } from '@bike4mind/database';
import { logEvent } from '@server/utils/analyticsLog';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';

// This api endpoint is used to set the active voice id
const handler = baseApi().post(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const userId = req.user?.id;
    const id = req.query.id!;

    await Voice.updateMany({ userId, isActive: true }, { isActive: false });

    const updatedApiKey = await Voice.findOneAndUpdate(
      { _id: id, userId },
      { isActive: true },
      { upsert: true, new: true }
    );

    await logEvent({ userId, type: ElabsEvents.SET_ACTIVE_ELABS_VOICE, metadata: { id } }, { ability: req.ability });

    return res.status(200).json(updatedApiKey);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
