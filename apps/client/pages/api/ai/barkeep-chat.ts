import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { ensureTavernAccess } from '@server/utils/errors';
import { OperationsModelService } from '@client/services/operationsModelService';

const BARKEEP_SYSTEM_PROMPT = `You are Grimbold, the jovial bartender of The Gilded Flagon tavern.
You speak in a warm, slightly rough medieval voice — think gruff but kind.
Keep responses to 1-2 short sentences (under 120 characters if possible).
You know the regulars, the local gossip, and the ale selection.
You occasionally mention: the town guard, the blacksmith next door, the library upstairs, the inn rooms, or the garden.
Never break character. Never mention AI, language models, or the real world.
If asked something you wouldn't know, deflect with tavern wisdom or a rumor.`;

interface BarkeepChatRequest {
  userMessage: string;
  history?: { role: 'user' | 'assistant'; content: string }[];
}

const handler = baseApi()
  .use(
    rateLimit({
      limit: process.env.NODE_ENV === 'development' ? 50 : 20,
      windowMs: 60 * 1000,
    })
  )
  .post(async (req: any, res) => {
    ensureTavernAccess(req.user);

    const { userMessage, history = [] }: BarkeepChatRequest = req.body;

    if (!userMessage || !userMessage.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    try {
      const { modelId, llm } = await OperationsModelService.getOperationsModel();

      const messages = [
        { role: 'system' as const, content: BARKEEP_SYSTEM_PROMPT },
        ...history.slice(-6),
        { role: 'user' as const, content: userMessage },
      ];

      let reply = '';
      await llm.complete(
        modelId,
        messages,
        { maxTokens: 150, temperature: 0.8 },
        async (chunks: (string | null | undefined)[]) => {
          reply += chunks.filter(Boolean).join('');
        }
      );

      const trimmed = (reply || '').trim();
      if (!trimmed) {
        throw new Error('Empty response from LLM');
      }

      return res.json({ reply: trimmed });
    } catch (error) {
      req.logger?.error?.('Barkeep chat error:', error);
      return res.status(500).json({
        error: 'The barkeep seems lost in thought. Try again.',
      });
    }
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
