import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { importHistoryJobRepository } from '@bike4mind/database';

const handler = baseApi({ auth: true }).get(
  asyncHandler(async (req, res) => {
    const { id } = req.query as any;
    const userId = req.user.id;

    const importJob = await importHistoryJobRepository.findByIdAndUserId(id, userId);

    if (!importJob) {
      return res.status(404).json({
        success: false,
        message: 'Import job not found',
      });
    }

    return res.json({
      success: true,
      data: importJob,
    });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
