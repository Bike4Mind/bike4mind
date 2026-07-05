import { ModelName, ChatModels, getTextModelCost } from '@bike4mind/common';
import { getAvailableModels } from '@bike4mind/llm-adapters';
interface TestCase {
  modelName: ModelName;
  inputTokens: number;
  outputTokens: number;
}

const testCases: TestCase[] = [
  { modelName: ChatModels.GPT4, inputTokens: 9000, outputTokens: 0 },
  { modelName: ChatModels.GPT4, inputTokens: 33000, outputTokens: 1000 },
];

export async function runModelCostTests() {
  for (const testCase of testCases) {
    const model = (await getAvailableModels(null)).find(m => m.id === testCase.modelName && m.type === 'text')!;
    const cost = getTextModelCost(model, testCase.inputTokens, testCase.outputTokens);
    console.log(
      `Cost for model ${testCase.modelName} with ${testCase.inputTokens} input tokens and ${testCase.outputTokens} output tokens: $${cost}`
    );
  }
}
