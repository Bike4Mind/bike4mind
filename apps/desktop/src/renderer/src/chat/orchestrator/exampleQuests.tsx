import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Typography from '@mui/joy/Typography';

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

/**
 * The quests above the composer of a session that has Orchestrate on but no agents and no messages yet.
 * The header's agents switch only appears once there is an agent, so this is where a new orchestrating
 * session finds its starters rather than on an empty stage.
 */
export function ExampleQuestStrip({ onPick }: { onPick(prompt: string): void }) {
  return (
    <Box
      data-testid="orchestrate-example-quests"
      sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.75, pb: 1 }}
    >
      <Typography level="body-xs" textColor="text.tertiary">
        Try an example quest
      </Typography>
      <ExampleQuestButtons onPick={onPick} />
    </Box>
  );
}
