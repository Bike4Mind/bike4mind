import { Request, Response } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { OllamaBackend } from '@bike4mind/llm-adapters';
import { AdminSettings } from '@bike4mind/database';

const handler = baseApi({ auth: false }).get(async (req: Request, res: Response) => {
  try {
    const ollamaSettings = await AdminSettings.find({ settingName: { $in: ['EnableOllama', 'ollamaBackend'] } });
    const ollamaBackend = ollamaSettings.find(setting => setting.settingName === 'ollamaBackend')?.settingValue;
    const enableOllama =
      !!ollamaBackend &&
      ollamaSettings.find(setting => setting.settingName === 'EnableOllama')?.settingValue.toString() === 'true';
    if (!enableOllama) {
      return res.status(403).json({ error: 'Ollama is not enabled in admin settings' });
    }

    const ollama = new OllamaBackend(ollamaBackend);

    const models = await ollama.listModels();
    return res.status(200).json({ models });
  } catch (error: any) {
    console.error('Error fetching Ollama models:', error);
    return res.status(500).json({
      error: 'Failed to fetch Ollama models',
      details: error.message,
    });
  }
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
