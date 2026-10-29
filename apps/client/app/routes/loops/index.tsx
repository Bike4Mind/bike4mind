import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Box, Button, CircularProgress, Sheet, Table, Typography } from '@mui/joy';
import AutorenewOutlinedIcon from '@mui/icons-material/AutorenewOutlined';
import AgentPageHeader from '@client/app/components/Agent/AgentPageHeader';
import LoopActions from '@client/app/components/Loops/LoopActions';
import LoopFormModal from '@client/app/components/Loops/LoopFormModal';
import {
  formatCredits,
  formatInterval,
  lastRunLabel,
  LoopStatusChip,
  nextRunLabel,
} from '@client/app/components/Loops/loopUi';
import { useLoops } from '@client/app/hooks/data/loops';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';

export default function LoopsPage() {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  // Only mounted inside LoopsGate, so the loops API is never called while EnableLoops is off.
  const { data: loops, isLoading } = useLoops();
  useDocumentTitle('Loops');

  const newLoopButton = (
    <Button size="sm" onClick={() => setCreating(true)} data-testid="loops-new-btn">
      New loop
    </Button>
  );

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto' }}>
      <AgentPageHeader
        title="Loops"
        backButton={false}
        titleIcon={<AutorenewOutlinedIcon sx={{ color: 'text.primary50' }} />}
        rightActions={newLoopButton}
      />
      <Box sx={{ p: 2 }}>
        {isLoading ? (
          <CircularProgress size="sm" />
        ) : !loops?.length ? (
          <Sheet
            variant="soft"
            sx={{ p: 4, borderRadius: 'md', textAlign: 'center', display: 'grid', gap: 2, justifyItems: 'center' }}
            data-testid="loops-empty-state"
          >
            <Typography>A loop runs an agent on a schedule and works through its tickets, stage by stage.</Typography>
            {newLoopButton}
          </Sheet>
        ) : (
          <Table hoverRow sx={{ '& tbody tr': { cursor: 'pointer' } }}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Schedule</th>
                <th>Last run</th>
                <th>Next run</th>
                <th>Runs</th>
                <th title="Top-level runs kept for 90 days">Credits (90 days)</th>
                <th style={{ width: 320 }} />
              </tr>
            </thead>
            <tbody>
              {loops.map(loop => (
                <tr
                  key={loop.id}
                  tabIndex={0}
                  onClick={() => navigate({ to: '/loops/$id', params: { id: loop.id } })}
                  onKeyDown={e => {
                    // Only the row itself: Enter on an action button inside it must not also open the loop.
                    if (e.key === 'Enter' && e.target === e.currentTarget) {
                      navigate({ to: '/loops/$id', params: { id: loop.id } });
                    }
                  }}
                  data-testid={`loops-row-${loop.id}`}
                >
                  <td>
                    <Typography level="title-sm">{loop.name}</Typography>
                  </td>
                  <td>
                    <LoopStatusChip loop={loop} />
                  </td>
                  <td>{formatInterval(loop.intervalMinutes)}</td>
                  <td>{lastRunLabel(loop)}</td>
                  <td data-testid="loops-row-next-run">{nextRunLabel(loop)}</td>
                  <td>{loop.runCount}</td>
                  <td>{formatCredits(loop.creditsUsed)}</td>
                  <td>
                    <LoopActions loop={loop} />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Box>
      {creating && <LoopFormModal open onClose={() => setCreating(false)} />}
    </Box>
  );
}
