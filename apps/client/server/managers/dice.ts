import { BadRequestError } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';

const logger = new Logger({ metadata: { service: 'dice' } });

/**
 * Upper bounds on a parsed dice spec. `numDice` drives the allocation loop below, so an
 * unbounded value lets a crafted spec (e.g. `"100000000d6"`) block the shared event loop for
 * seconds while it builds the rolls array. Both are capped far above any legitimate roll
 * (the UI generates at most 20 dice with 20 sides).
 */
export const MAX_DICE_COUNT = 10_000;
export const MAX_DICE_SIDES = 10_000;

export function rollDice(diceSpec: string): number {
  logger.debug('Rolling dice', { diceSpec });

  let numDice = 1;
  let numSides = 100;

  if (diceSpec && diceSpec.includes('d')) {
    const diceSpecSplit = diceSpec.split('d');
    numDice = diceSpecSplit[0] ? parseInt(diceSpecSplit[0], 10) : 1;
    numSides = diceSpecSplit[1] ? parseInt(diceSpecSplit[1], 10) : 6;
  }

  // Bound both parsed values before the loop runs: a whole number in range, nothing else.
  if (!Number.isInteger(numDice) || numDice < 1 || numDice > MAX_DICE_COUNT) {
    throw new BadRequestError(`Dice count must be a whole number between 1 and ${MAX_DICE_COUNT}`);
  }
  if (!Number.isInteger(numSides) || numSides < 1 || numSides > MAX_DICE_SIDES) {
    throw new BadRequestError(`Dice sides must be a whole number between 1 and ${MAX_DICE_SIDES}`);
  }

  logger.debug('Parsed dice spec', { numDice, numSides });

  let roll = 0;
  const individualRolls: number[] = [];

  for (let i = 0; i < numDice; i++) {
    const singleRoll = Math.floor(Math.random() * numSides) + 1;
    individualRolls.push(singleRoll);
    roll += singleRoll;
  }

  logger.debug('Dice rolled', { individualRolls, total: roll });
  return roll;
}
