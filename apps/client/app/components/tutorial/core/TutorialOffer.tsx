import { useEffect } from 'react';
import { Button, Link, Stack, Typography } from '@mui/joy';
import SchoolOutlinedIcon from '@mui/icons-material/SchoolOutlined';
import type { TutorialTrack } from '@bike4mind/common';
import { useTutorialsEnabled } from '@client/app/hooks/data/tutorials';
import { useTutorialRunModules } from '@client/app/hooks/tutorials/useTutorialRun';
import { CORE_TUTORIALS_API_BASE } from '../hostBase';
import { useTutorialPicker } from './tutorialPickerStore';
import { useCalmMoment } from './useCalmMoment';

const TRACK_BUTTONS: readonly { track: TutorialTrack; label: string }[] = [
  { track: 'basics', label: "I'm new to AI chat" },
  { track: 'different', label: "Show me what's different" },
];

/**
 * The tour offer on the welcome card. It waits for a calm moment, offers a track per kind of newcomer, and never
 * starts a walk by itself; the card's own starter prompts stay for anyone who just wants to type.
 */
export function TutorialOffer() {
  const enabled = useTutorialsEnabled();
  const calm = useCalmMoment(enabled);
  const { data: modules, isPending } = useTutorialRunModules({ enabled, apiBase: CORE_TUTORIALS_API_BASE });
  const requestTrack = useTutorialPicker(s => s.requestTrack);
  const openPicker = useTutorialPicker(s => s.setOpen);
  const answered = useTutorialPicker(s => s.offerAnswered);
  const answerOffer = useTutorialPicker(s => s.answerOffer);
  const setOfferWaiting = useTutorialPicker(s => s.setOfferWaiting);

  // Waiting starts before the calm moment, so a surface that settles sooner cannot take the first screen first.
  const waiting = enabled && !answered && (isPending || Boolean(modules?.length));
  useEffect(() => {
    setOfferWaiting(waiting);
    return () => setOfferWaiting(false);
  }, [waiting, setOfferWaiting]);

  const tracks = TRACK_BUTTONS.filter(({ track }) => modules?.some(m => m.track === track));
  if (!enabled || !calm || !modules?.length) return null;

  return (
    <Stack data-testid="tutorial-offer" gap={1} sx={{ p: 1.5, borderRadius: 'sm', bgcolor: 'background.level1' }}>
      <Stack direction="row" alignItems="center" gap={1}>
        <SchoolOutlinedIcon fontSize="small" />
        <Typography level="title-sm">Want a quick guided tour?</Typography>
      </Stack>
      <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
        A few short steps, each one skippable. Leave any time and pick it up later from Help.
      </Typography>
      <Stack direction={{ xs: 'column', sm: 'row' }} gap={1} alignItems={{ xs: 'stretch', sm: 'center' }}>
        {tracks.map(({ track, label }, index) => (
          <Button
            key={track}
            size="sm"
            variant={index === 0 ? 'solid' : 'outlined'}
            onClick={() => {
              answerOffer();
              requestTrack(track);
            }}
            data-testid={`tutorial-offer-${track}`}
          >
            {label}
          </Button>
        ))}
        <Link
          component="button"
          level="body-sm"
          onClick={() => {
            answerOffer();
            openPicker(true);
          }}
          data-testid="tutorial-offer-all"
          sx={{ alignSelf: { xs: 'center', sm: 'auto' } }}
        >
          See all tutorials
        </Link>
      </Stack>
    </Stack>
  );
}
