import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { startNotebookCuration } from '@bike4mind/server-utils/notebooks/startNotebookCuration';
import { NotebookCurateRequestSchema } from '../../../types/api';
import { z } from 'zod';

const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated',
      });
    }

    let validatedBody: z.infer<typeof NotebookCurateRequestSchema>;
    try {
      validatedBody = NotebookCurateRequestSchema.parse(req.body);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          success: false,
          message: 'Invalid request body',
          errors: error.issues.map(err => ({
            field: err.path.join('.'),
            message: err.message,
          })),
        });
      }
      throw error;
    }

    // Passing the schema-typed body pins NotebookCurateRequestSchema to NotebookCurationInput at compile time.
    const { status, body } = await startNotebookCuration(req, userId, validatedBody);
    return res.status(status).json(body);
  })
);

export default handler;

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '1mb',
    },
    externalResolver: true,
  },
};
