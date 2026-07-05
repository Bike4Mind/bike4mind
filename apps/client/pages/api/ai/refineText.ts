import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { refineText } from '@bike4mind/services';
import { IMessage } from '@bike4mind/common';
import { OperationsModelService } from '@client/services/operationsModelService';

const handler = baseApi().get(
  asyncHandler(async (req, res) => {
    const { text, context } = req.query as any;
    const { modelId, llm } = await OperationsModelService.getOperationsModel();

    if (!llm) {
      throw new Error('Failed to initialize LLM');
    }

    const enhancedText = await refineText(
      { text, context },
      {
        llm: {
          complete: async (messages, callback) => {
            await llm.complete(
              modelId,
              messages as unknown as IMessage[],
              { stream: false, maxTokens: Infinity },
              async text => {
                await callback(text[0]);
              }
            );
          },
        },
      }
    );

    res.json({ text: enhancedText });
  })
);

export default handler;
