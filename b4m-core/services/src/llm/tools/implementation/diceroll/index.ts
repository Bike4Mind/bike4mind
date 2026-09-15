import { ToolDefinition } from '../../base/types';
import random from 'lodash/random.js';
import sum from 'lodash/sum.js';
import times from 'lodash/times.js';

interface DiceRollParams {
  sides: number;
  times: number;
}

const diceRoll = async (parameters?: DiceRollParams): Promise<string> => {
  if (!parameters?.sides || !parameters?.times) {
    throw new Error('Tool dice roll: Missing required parameters');
  }

  return sum(times(parameters.times, () => random(1, parameters.sides))).toString();
};

export const diceRollTool: ToolDefinition = {
  name: 'dice_roll',
  implementation: () => ({
    toolFn: value => diceRoll(value as DiceRollParams),
    toolSchema: {
      name: 'dice_roll',
      description: 'Return the sum of rolling a dice with the given number of sides a given number of times.',
      parameters: {
        type: 'object',
        properties: {
          sides: {
            type: 'number',
            description: 'Number of sides on the dice.',
          },
          times: {
            type: 'number',
            description: 'Number of times to roll the dice.',
          },
        },
        required: ['sides', 'times'],
      },
    },
  }),
};
