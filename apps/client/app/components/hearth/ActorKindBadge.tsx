import { Chip } from '@mui/joy';
import { actorKindLabel, type ActorKind } from '@bike4mind/hearth';

/**
 * The actor's kind, always rendered beside the actor name.
 *
 * Two jobs. It is the second signal that keeps per-actor color from being the
 * only thing telling two posters apart (color is a four-hue palette, so actors
 * do share hues). And it is the visible half of the actor-spoofing mitigation:
 * `human` is reserved server-side, so an agent that names itself after a person
 * still reads as an Agent here. Rendered for every kind including `human` - a
 * badge that appears only on the suspicious case teaches readers nothing.
 *
 * `outlined` deliberately: the state chips in the roster are `soft` and carry
 * urgency, and a neutral identity fact must not compete with "needs permission".
 */
export default function ActorKindBadge({ kind, testId }: { kind?: ActorKind; testId: string }) {
  return (
    <Chip size="sm" variant="outlined" color="neutral" data-testid={testId}>
      {actorKindLabel(kind)}
    </Chip>
  );
}
