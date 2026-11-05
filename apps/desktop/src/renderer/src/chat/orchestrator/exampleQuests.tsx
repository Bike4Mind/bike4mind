import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';

export interface ExampleQuest {
  label: string;
  prompt: string;
}

/** Starter prompts for an empty stage: each shows off running several agents at once. */
export const EXAMPLE_QUESTS: readonly ExampleQuest[] = [
  {
    label: 'Audit this repo',
    prompt:
      'Audit this repository using several agents in parallel: one for TODO/FIXME comments, one for the largest files and how to split them, one for unused exports. Combine the findings into a short report with the top 3 fixes.',
  },
  {
    label: 'Write missing tests',
    prompt:
      'Find three pure functions without unit tests in different files, and use one agent per file to write and run a test for each. Then summarize what was added.',
  },
  {
    label: 'Compare approaches',
    prompt:
      'I want to compare different approaches to <describe the problem>. Have one agent research each approach and then give me a side-by-side comparison with a recommendation.',
  },
];

/** Picking one fills the composer for the user to edit; nothing is sent. */
export function ExampleQuestButtons({ onPick }: { onPick(prompt: string): void }) {
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, justifyContent: 'center' }}>
      {EXAMPLE_QUESTS.map((quest, index) => (
        <Button
          key={quest.label}
          size="sm"
          variant="outlined"
          color="neutral"
          data-testid={`orchestrator-example-quest-${index + 1}`}
          onClick={() => onPick(quest.prompt)}
        >
          {quest.label}
        </Button>
      ))}
    </Box>
  );
}
