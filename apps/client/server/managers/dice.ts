export function rollDice(diceSpec: string): number {
  console.log(`[DICE-MANAGER] Rolling dice with spec: ${diceSpec}`);

  let numDice: number = 1;
  let numSides: number = 100;

  if (diceSpec && diceSpec.includes('d')) {
    const diceSpecSplit: string[] = diceSpec.split('d');
    numDice = diceSpecSplit[0] ? parseInt(diceSpecSplit[0]) : 1;
    numSides = diceSpecSplit[1] ? parseInt(diceSpecSplit[1]) : 6;
  }

  console.log(`[DICE-MANAGER] Parsed spec: ${numDice} dice with ${numSides} sides each`);

  let roll: number = 0;
  const individualRolls: number[] = [];

  for (let i = 0; i < numDice; i++) {
    const singleRoll = Math.floor(Math.random() * numSides) + 1;
    individualRolls.push(singleRoll);
    roll += singleRoll;
  }

  console.log(`[DICE-MANAGER] Individual rolls: [${individualRolls.join(', ')}], Total: ${roll}`);
  return roll;
}
