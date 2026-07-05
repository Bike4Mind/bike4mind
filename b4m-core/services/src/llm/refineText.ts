import { IMessage } from '@bike4mind/common';
import { z } from 'zod';

export const refineTextLLMSchema = z.object({
  text: z.string(),
  context: z.string().optional(),
  // tone: z.enum(['formal', 'informal', 'neutral']).optional(),
  // style: z.enum(['technical', 'creative', 'academic', 'business', 'narrative']).optional(),
});

export type RefineTextLLMParameters = z.infer<typeof refineTextLLMSchema>;

interface RefineTextLLMAdapters {
  llm: {
    complete: (message: IMessage[], callback: (val: string | undefined | null) => Promise<void>) => Promise<void>;
  };
}

export const refineText = async (parameters: RefineTextLLMParameters, adapters: RefineTextLLMAdapters) => {
  const { text, context } = refineTextLLMSchema.parse(parameters);

  const messages: IMessage[] = [
    {
      role: 'user',
      content: `Refine the following text description to make it more concise, clear, and detailed. Use your best judgment to interpret vague descriptions and enhance them with relevant details while maintaining the original intent.
${
  context
    ? `
Context:
${context}
`
    : ''
}

Original text:
${text}

Return your refined version wrapped in the following tags:
<refine_text>
[Your refined text here]
</refine_text>
        `,
    },
  ];

  let refinedText: string | undefined;
  await adapters.llm.complete(messages, async val => {
    if (!val) return;

    const match = val.match(/<refine_text>([\s\S]*?)<\/refine_text>/);
    refinedText = match ? match[1].trim() : val.trim();
  });

  return refinedText;
};
