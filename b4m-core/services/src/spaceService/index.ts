import { create } from './create';
import { get } from './get';
import { leave } from './leave';
import { listMine } from './listMine';
import { remove } from './remove';
import { removeMember } from './removeMember';
import { setMemberRole } from './setMemberRole';
import { transferOwnership } from './transferOwnership';
import { update } from './update';
import { loadForMember } from './loadForMember';
import { joinViaDomain } from './joinViaDomain';
import { listDomainSuggestions } from './listDomainSuggestions';
import { recheckDomainMembers } from './recheckDomainMembers';
import { notifySpaceDomainReleased } from './notifySpaceDomainReleased';
import type { SpaceWithUsers } from './get';
import type { SpaceDomainSuggestion } from './listDomainSuggestions';

export {
  create,
  get,
  listMine,
  update,
  remove,
  leave,
  removeMember,
  setMemberRole,
  transferOwnership,
  loadForMember,
  joinViaDomain,
  listDomainSuggestions,
  recheckDomainMembers,
  notifySpaceDomainReleased,
};

export type { SpaceWithUsers, SpaceDomainSuggestion };
