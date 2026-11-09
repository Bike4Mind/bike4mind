import { describe, expect, it } from 'vitest';
import { holderExportScope, viaParentExportScope, type ExportScope, type ReferenceMatch } from './exportScope';
import { DATA_HOLDER_REGISTRY } from './registry';
import type { DataHolder, UserReference } from './types';

type ViaParentHolder = Extract<DataHolder, { kind: 'viaParent' }>;

function referencesOf(modelName: string): readonly UserReference[] {
  const holder = DATA_HOLDER_REGISTRY[modelName];
  if (holder.kind === 'subject' || holder.kind === 'holder') return holder.references;
  if (holder.kind === 'viaParent') return holder.attribution ?? [];
  throw new Error(`${modelName} has no references`);
}

function match(modelName: string, path: string, throughArray = false): ReferenceMatch {
  const reference = referencesOf(modelName).find(candidate => candidate.path === path);
  if (!reference) throw new Error(`${modelName} has no reference at ${path}`);
  return { reference, throughArray };
}

function viaParent(modelName: string): ViaParentHolder {
  const holder = DATA_HOLDER_REGISTRY[modelName];
  if (holder.kind !== 'viaParent') throw new Error(`${modelName} is not a viaParent holder`);
  return holder;
}

const WHOLE: ExportScope = { scope: 'wholeDocument' };
const NONE: ExportScope = { scope: 'none' };

describe('holderExportScope', () => {
  it('exports nothing when no reference matched', () => {
    expect(holderExportScope([])).toEqual(NONE);
  });

  it("exports only the referrer's id from a referred user's record, not the rest of it", () => {
    expect(holderExportScope([match('User', 'referredByUserId')])).toEqual({
      scope: 'matchedPaths',
      paths: ['referredByUserId'],
    });
  });

  it('exports only the matched paths of a document that merely records the person', () => {
    expect(
      holderExportScope([match('LakeAccessEvent', 'principalId'), match('LakeAccessEvent', 'onBehalfOfUserId')])
    ).toEqual({ scope: 'matchedPaths', paths: ['principalId', 'onBehalfOfUserId'] });
  });

  it("carries an anonymize reference's alsoRedact fields, which repeat the same person's identity", () => {
    expect(holderExportScope([match('ToolDefinitionOverride', 'lastUpdatedBy')])).toEqual({
      scope: 'matchedPaths',
      paths: ['lastUpdatedBy', 'lastUpdatedByName'],
    });
  });

  it("exports the whole document on a scalar deleteDocument match, the person's own record", () => {
    expect(holderExportScope([match('SessionModel', 'userId')])).toEqual(WHOLE);
  });

  it('exports the whole document on a scalar retain match', () => {
    expect(holderExportScope([match('AdminAuditLog', 'target.id')])).toEqual(WHOLE);
  });

  it("exports only the actor's reference and identifying fields from a record about someone else", () => {
    expect(holderExportScope([match('AdminAuditLog', 'actor.userId')])).toEqual({
      scope: 'matchedPaths',
      paths: ['actor.userId', 'actor.email', 'actor.name', 'context.ip', 'context.userAgent'],
    });
  });

  it('exports only the matching elements on an array match, whatever the action', () => {
    expect(holderExportScope([match('SessionModel', 'users.userId', true)])).toEqual({
      scope: 'matchedPaths',
      paths: ['users.userId'],
    });
  });

  it('lets an own-record match decide when it matches beside an anonymize', () => {
    expect(holderExportScope([match('EmailSendAttempt', 'sentBy'), match('EmailSendAttempt', 'recipientId')])).toEqual(
      WHOLE
    );
  });
});

describe('viaParentExportScope', () => {
  const quest = viaParent('Quest');

  it('follows a parent exported whole', () => {
    expect(viaParentExportScope(quest, WHOLE, [])).toEqual(WHOLE);
  });

  it("is excluded when only the parent matched and the parent is not the person's own record", () => {
    const sharedNotebook = holderExportScope([match('SessionModel', 'users.userId', true)]);
    expect(viaParentExportScope(quest, sharedNotebook, [])).toEqual(NONE);
  });

  it('is excluded when nothing matched it or its parent', () => {
    expect(viaParentExportScope(quest, NONE, [])).toEqual(NONE);
  });

  it("exports only its own attribution paths when the person matches the child's attribution", () => {
    expect(viaParentExportScope(quest, NONE, [match('Quest', 'promptMeta.humanReview.reviewedBy')])).toEqual({
      scope: 'matchedPaths',
      paths: ['promptMeta.humanReview.reviewedBy'],
    });
  });

  it("exports the person's own content whole under a parent that only records them", () => {
    const accessEvent = holderExportScope([match('LakeAccessEvent', 'principalId')]);
    expect(viaParentExportScope(viaParent('LakeAccessQueryText'), accessEvent, [])).toEqual(WHOLE);
  });
});
