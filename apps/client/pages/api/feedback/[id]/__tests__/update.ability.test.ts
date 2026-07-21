import { describe, it, expect } from 'vitest';
import { AbilityBuilder, createMongoAbility } from '@casl/ability';

/**
 * Locks in the CASL semantics the feedback-update fix depends on. Importing the
 * real `defineAbilitiesFor` is not viable here: its transitive graph pulls
 * `b4m-core/utils/dist/registrableDomain.mjs -> tldts`, which the current vitest
 * setup cannot resolve (the same failure that affects the publish/* suites on
 * main). So this replicates ability.ts's feedback rules exactly and asserts the
 * class-vs-instance behavior directly.
 *
 * MUST STAY IN SYNC with the feedback rules in `apps/client/server/auth/ability.ts`:
 *   allow('update', FeedbackModel, { userId: user.id });   // every user
 *   if (user.isAdmin) allow('update', FeedbackModel);       // admins, unconditional
 */

class FeedbackModel {}

function abilityFor(user: { id: string; isAdmin?: boolean }) {
  const { can: allow, build } = new AbilityBuilder(createMongoAbility);
  allow('update', FeedbackModel, { userId: user.id });
  if (user.isAdmin) allow('update', FeedbackModel);
  return build({ detectSubjectType: item => (item as { constructor: unknown }).constructor as never });
}

const feedback = Object.assign(new FeedbackModel(), { userId: 'owner1' });

describe('feedback update authorization (CASL class-vs-instance)', () => {
  it('allows the owner to update their own feedback (instance check)', () => {
    expect(abilityFor({ id: 'owner1' }).can('update', feedback)).toBe(true);
  });

  it("denies a stranger updating someone else's feedback (instance check)", () => {
    expect(abilityFor({ id: 'stranger' }).can('update', feedback)).toBe(false);
  });

  it('allows an admin to update any feedback (instance check)', () => {
    expect(abilityFor({ id: 'admin', isAdmin: true }).can('update', feedback)).toBe(true);
  });

  it('documents the footgun: the by-class check wrongly passes for a stranger', () => {
    const ability = abilityFor({ id: 'stranger' });
    // A by-class check ignores the { userId } condition, so it returns true even
    // though the stranger cannot update this instance -- which is exactly why the
    // handler authorizes against the document instance.
    expect(ability.can('update', FeedbackModel)).toBe(true);
    expect(ability.can('update', feedback)).toBe(false);
  });
});
