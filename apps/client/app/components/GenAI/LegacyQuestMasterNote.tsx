import { Alert } from '@mui/joy';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { LEGACY_QUESTMASTER_NOTE } from './legacyQuestMasterPlan';

/**
 * Stands in for a reply or a knowledge-viewer tab that held a retired in-chat QuestMaster plan.
 * Static on purpose: the plan rows are no longer served, so this never fetches.
 */
const LegacyQuestMasterNote = () => (
  <Alert
    data-testid="legacy-questmaster-note"
    variant="soft"
    color="neutral"
    startDecorator={<InfoOutlinedIcon />}
    sx={{ my: 1 }}
  >
    {LEGACY_QUESTMASTER_NOTE}
  </Alert>
);

export default LegacyQuestMasterNote;
