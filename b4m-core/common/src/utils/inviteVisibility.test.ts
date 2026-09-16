import { describe, it, expect } from 'vitest';
import { isLinkOnlyInvite } from './inviteVisibility';
import { InviteType } from '../types/entities/InviteType';

const invite = (over: Partial<Parameters<typeof isLinkOnlyInvite>[0]>) =>
  ({ type: InviteType.FabFile, ...over }) as Parameters<typeof isLinkOnlyInvite>[0];

describe('isLinkOnlyInvite', () => {
  describe('the persisted flag wins outright', () => {
    it('reads a true flag as link-only whatever the recipients say', () => {
      expect(isLinkOnlyInvite(invite({ isLinkOnly: true, recipients: { pending: ['a@x.com'], accepted: [] } }))).toBe(
        true
      );
    });

    it('reads a false flag as named even with no recipients left', () => {
      expect(isLinkOnlyInvite(invite({ isLinkOnly: false, recipients: { pending: [], accepted: [] } }))).toBe(false);
    });

    it('does not treat a false flag as absent', () => {
      expect(isLinkOnlyInvite(invite({ isLinkOnly: false }))).toBe(false);
    });
  });

  describe('legacy rows with no flag fall back to inferring it', () => {
    it('infers link-only for a FabFile naming nobody', () => {
      expect(isLinkOnlyInvite(invite({ recipients: { pending: [], accepted: [] } }))).toBe(true);
    });

    it('infers link-only when recipients is absent entirely', () => {
      expect(isLinkOnlyInvite(invite({}))).toBe(true);
    });

    it('infers named from a pending recipient', () => {
      expect(isLinkOnlyInvite(invite({ recipients: { pending: ['a@x.com'], accepted: [] } }))).toBe(false);
    });

    it('infers named from an accepted recipient', () => {
      expect(isLinkOnlyInvite(invite({ recipients: { pending: [], accepted: ['a@x.com'] } }))).toBe(false);
    });

    // Accepting and declining both move an address out of `pending`. Reading only pending+accepted
    // made an all-declined invite infer as a share link, which opens the view gate to any
    // authenticated caller and lets anyone redeem it.
    it('infers named from a refused recipient, not link-only', () => {
      expect(isLinkOnlyInvite(invite({ recipients: { pending: [], accepted: [], refused: ['a@x.com'] } }))).toBe(false);
    });

    it('infers named when every recipient has declined', () => {
      expect(
        isLinkOnlyInvite(invite({ recipients: { pending: [], accepted: [], refused: ['a@x.com', 'b@x.com'] } }))
      ).toBe(false);
    });

    // Only FabFile and Session were ever link-shareable. The other types carry raw user ids that
    // the old resolution could not resolve, so an empty pending there means unresolved, not open.
    it.each([InviteType.Project, InviteType.Organization, InviteType.Group, InviteType.Tool])(
      'fails closed for a legacy %s invite naming nobody',
      type => {
        expect(isLinkOnlyInvite(invite({ type, recipients: { pending: [], accepted: [] } }))).toBe(false);
      }
    );

    it('infers link-only for a Session naming nobody', () => {
      expect(isLinkOnlyInvite(invite({ type: InviteType.Session, recipients: { pending: [], accepted: [] } }))).toBe(
        true
      );
    });
  });
});
