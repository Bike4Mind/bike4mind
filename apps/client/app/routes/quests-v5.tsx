import Box from '@mui/joy/Box';
import QuestGraphView from '@client/app/components/questmaster-v5/QuestGraphView';
import { LegacyQuestmasterBanner } from '@client/app/components/questmaster/LegacyQuestmasterRetirement';

/**
 * QuestMaster v5 - the node-graph quest surface. Runs alongside the legacy
 * /quests route (untouched) behind the `enableQuestMasterV5` flag until v5 wins.
 */
export default function QuestMasterV5Page() {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Box sx={{ px: 2, pt: 2 }}>
        <LegacyQuestmasterBanner />
      </Box>
      <Box sx={{ flex: 1, minHeight: 0 }}>
        <QuestGraphView />
      </Box>
    </Box>
  );
}
