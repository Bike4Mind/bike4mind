import type { TutorialModuleIntro } from '../../types';

// Made-up figures: the recorded answer for turn 2 is worked out from exactly this sheet, so edit both together.
const MONTHLY_SPENDING_CSV = `Item,Monthly cost (USD)
Rent,1450
Groceries,512
Restaurants and takeaway,286
Fuel,140
Electricity,96
Internet,65
Phone plan,48
Streaming services,52
Gym membership,60
Clothes,120
Coffee shops,74
Car insurance,110
`;

export const firstStepsModule: TutorialModuleIntro = {
  id: 'first-steps',
  title: 'First steps',
  pitch: 'Ask for help with a real task, refine the answer, and ask about a file.',
  openingPrompt:
    'Help me write a short, polite email to my landlord asking when the broken heater in my apartment will be fixed.',
  sheet: { name: 'monthly-spending.csv', csv: MONTHLY_SPENDING_CSV },
};
