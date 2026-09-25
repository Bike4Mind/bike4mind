import { Alert, Button, Stack, Typography } from '@mui/joy';
import {
  useAcceptLakeOwnershipOffer,
  useDeclineLakeOwnershipOffer,
  useOwnLakeOwnershipOffers,
} from '@client/app/hooks/data/dataLakes';

/**
 * The recipient's pending ownership offers, shown above the lakes list.
 *
 * This banner is how a recipient FINDS an offer: there is no general in-app notification centre, so
 * the email points here. It renders nothing when there is none - an empty banner would be a
 * permanent fixture with no content.
 *
 * The accept confirmation is folded into the banner rather than a second modal: the two facts that
 * matter - the lake's instructions will apply to the recipient's chats, and ownership bypasses the
 * lake's content gate - are stated BEFORE the button, which is where a warning has to be to be read.
 */
export default function LakeOwnershipOffersBanner() {
  const { data: offers } = useOwnLakeOwnershipOffers();
  const accept = useAcceptLakeOwnershipOffer();
  const decline = useDeclineLakeOwnershipOffer();

  if (!offers || offers.length === 0) return null;

  return (
    <Stack gap={1} sx={{ mb: 1.5 }} data-testid="lake-ownership-offers-banner">
      {offers.map(offer => (
        <Alert key={offer.id} color="primary" variant="soft" data-testid={`lake-ownership-offer-${offer.id}`}>
          <Stack gap={0.75} sx={{ width: '100%' }}>
            <Typography level="body-sm">
              <strong>{offer.offeredByName ?? 'A teammate'}</strong> has offered you ownership of{' '}
              <strong>{offer.lakeName}</strong>. Accepting makes you its owner, and the lake&apos;s instructions will
              apply to your chats.
              {offer.expiresAt ? ` The offer expires ${new Date(offer.expiresAt).toLocaleDateString()}.` : ''}
            </Typography>
            {/* The same disclosure the offerer saw when they sent it: ownership overrides the gate, so
                whoever accepts can read everything in the lake whether or not they satisfy it. */}
            {offer.gate && (
              <Typography level="body-xs" textColor="warning.700" data-testid={`lake-ownership-offer-gate-${offer.id}`}>
                This lake is gated on{' '}
                {[
                  offer.gate.requiredUserTag ? `the access tag "${offer.gate.requiredUserTag}"` : null,
                  offer.gate.requiredEntitlement ? `the entitlement "${offer.gate.requiredEntitlement}"` : null,
                ]
                  .filter(Boolean)
                  .join(' and ')}
                . Ownership overrides that gate.
              </Typography>
            )}
            <Stack direction="row" gap={1}>
              <Button
                size="sm"
                loading={accept.isPending}
                onClick={() => accept.mutate({ offerId: offer.id, dataLakeId: offer.dataLakeId })}
                data-testid="lake-ownership-offer-accept-btn"
              >
                Accept ownership
              </Button>
              <Button
                size="sm"
                variant="plain"
                color="neutral"
                loading={decline.isPending}
                onClick={() => decline.mutate({ offerId: offer.id })}
                data-testid="lake-ownership-offer-decline-btn"
              >
                Decline
              </Button>
            </Stack>
          </Stack>
        </Alert>
      ))}
    </Stack>
  );
}
