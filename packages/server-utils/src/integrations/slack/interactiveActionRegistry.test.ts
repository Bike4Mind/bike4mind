import { describe, expect, it, vi } from 'vitest';
import {
  buildSlackInteractiveActionRegistry,
  findSlackInteractiveActionHandler,
  type SlackInteractiveActionHandler,
} from './interactiveActionRegistry';

type Claims = Pick<SlackInteractiveActionHandler, 'actionIds' | 'actionIdPrefixes'>;

function entry(claims: Claims) {
  return { ...claims, handle: vi.fn().mockResolvedValue({ response: {} }) } satisfies SlackInteractiveActionHandler;
}

const NO_RESERVED = { ids: [], prefixes: [] };

describe('buildSlackInteractiveActionRegistry', () => {
  describe('lookup', () => {
    it('finds a handler by exact id and by prefix, and nothing else', () => {
      const byId = entry({ actionIds: ['approve_thing'] });
      const byPrefix = entry({ actionIdPrefixes: ['menu_'] });
      const registry = buildSlackInteractiveActionRegistry([byId, byPrefix], [], NO_RESERVED);

      expect(registry.find('approve_thing')).toBe(byId);
      expect(registry.find('menu_42')).toBe(byPrefix);
      expect(registry.find('menu_')).toBe(byPrefix);
      expect(registry.find('approve_thing_2')).toBeUndefined();
      expect(registry.find('other')).toBeUndefined();
    });

    it('finds a contributed handler the same way and keeps the core ones', () => {
      const core = entry({ actionIds: ['core_action'] });
      const exact = entry({ actionIds: ['ext_action'] });
      const prefixed = entry({ actionIdPrefixes: ['ext_menu_'] });
      const registry = buildSlackInteractiveActionRegistry([core], [exact, prefixed], NO_RESERVED);

      expect(registry.problems).toEqual([]);
      expect(registry.find('core_action')).toBe(core);
      expect(registry.find('ext_action')).toBe(exact);
      expect(registry.find('ext_menu_9')).toBe(prefixed);
    });

    it('prefers an exact id over a prefix, and the longest matching prefix over a shorter one', () => {
      const prefixed = entry({ actionIdPrefixes: ['group_'] });
      const exact = entry({ actionIds: ['group_special'] });
      const shortPrefix = entry({ actionIdPrefixes: ['group_'] });
      const longPrefix = entry({ actionIdPrefixes: ['group_nested_'] });

      expect(findSlackInteractiveActionHandler([prefixed, exact], 'group_special')).toBe(exact);
      expect(findSlackInteractiveActionHandler([shortPrefix, longPrefix], 'group_nested_1')).toBe(longPrefix);
      expect(findSlackInteractiveActionHandler([longPrefix, shortPrefix], 'group_nested_1')).toBe(longPrefix);
      expect(findSlackInteractiveActionHandler([shortPrefix, longPrefix], 'group_other')).toBe(shortPrefix);
    });
  });

  describe('contributed entry shape', () => {
    it('treats input that is not an array as one problem and no contributed entries', () => {
      const core = entry({ actionIds: ['core_action'] });
      const registry = buildSlackInteractiveActionRegistry([core], { actionIds: ['ext_action'] } as never, NO_RESERVED);

      expect(registry.problems).toHaveLength(1);
      expect(registry.problems[0]).toContain('not an array');
      expect(registry.find('ext_action')).toBeUndefined();
      expect(registry.find('core_action')).toBe(core);
    });

    it.each([
      ['null', null],
      ['a string', 'ext_action'],
      ['an array', [{ actionIds: ['ext_action'] }]],
      ['undefined', undefined],
    ])('leaves out an entry that is %s', (_label, value) => {
      const registry = buildSlackInteractiveActionRegistry([], [value], NO_RESERVED);

      expect(registry.problems).toEqual(['contributed entry 0 is not an object']);
    });

    it.each([
      ['missing', undefined],
      ['not a function', 'handle'],
    ])('leaves out an entry whose handle is %s', (_label, handle) => {
      const registry = buildSlackInteractiveActionRegistry([], [{ actionIds: ['ext_action'], handle }], NO_RESERVED);

      expect(registry.problems).toEqual(['contributed entry 0 has no handle function']);
      expect(registry.find('ext_action')).toBeUndefined();
    });

    it.each([
      ['neither list', {}],
      ['empty lists', { actionIds: [], actionIdPrefixes: [] }],
    ])('leaves out an entry with %s', (_label, claims) => {
      const registry = buildSlackInteractiveActionRegistry([], [entry(claims)], NO_RESERVED);

      expect(registry.problems).toEqual(['contributed entry 0 declares no action ids or prefixes']);
    });

    it.each([
      ['actionIds', { actionIds: 'ext_action' }],
      ['actionIdPrefixes', { actionIdPrefixes: 'ext_menu_' }],
    ])('leaves out an entry whose %s is not an array', (field, claims) => {
      const registry = buildSlackInteractiveActionRegistry([], [entry(claims as never)], NO_RESERVED);

      expect(registry.problems).toEqual([`contributed entry 0 has ${field} that is not an array`]);
    });

    it.each([
      ['an id that is not a string', { actionIds: [42] }, 'action id of type number'],
      ['a prefix that is not a string', { actionIdPrefixes: [null] }, 'action id prefix of type object'],
      ['an id with an uppercase letter', { actionIds: ['Ext_action'] }, 'invalid action id "Ext_action"'],
      ['an id starting with a digit', { actionIds: ['1ext_action'] }, 'invalid action id "1ext_action"'],
      ['an id with a hyphen', { actionIds: ['ext-action'] }, 'invalid action id "ext-action"'],
      ['an empty id', { actionIds: [''] }, 'invalid action id ""'],
      ['an id with whitespace', { actionIds: ['ext action'] }, 'invalid action id "ext action"'],
      ['a prefix with a dot', { actionIdPrefixes: ['ext.menu_'] }, 'invalid action id prefix "ext.menu_"'],
      ['a prefix of 3 characters', { actionIdPrefixes: ['ext'] }, 'shorter than 4 characters'],
    ])('leaves out an entry with %s', (_label, claims, expected) => {
      const registry = buildSlackInteractiveActionRegistry([], [entry(claims as never)], NO_RESERVED);

      expect(registry.problems).toHaveLength(1);
      expect(registry.problems[0]).toContain('contributed entry 0');
      expect(registry.problems[0]).toContain(expected);
    });

    it('accepts a prefix of exactly 4 characters', () => {
      const registry = buildSlackInteractiveActionRegistry([], [entry({ actionIdPrefixes: ['ext_'] })], NO_RESERVED);

      expect(registry.problems).toEqual([]);
      expect(registry.find('ext_anything')).toBeDefined();
    });

    it('leaves out an entry whole when any one of its ids or prefixes is invalid', () => {
      const registry = buildSlackInteractiveActionRegistry(
        [],
        [entry({ actionIds: ['ext_valid', 'Ext_Invalid'], actionIdPrefixes: ['ext_menu_'] })],
        NO_RESERVED
      );

      expect(registry.problems).toHaveLength(1);
      expect(registry.find('ext_valid')).toBeUndefined();
      expect(registry.find('ext_menu_1')).toBeUndefined();
    });

    it('reports an entry that throws when it is read instead of throwing', () => {
      const hostile = {
        handle: () => {},
        get actionIds(): string[] {
          throw new Error('boom');
        },
      };
      const survivor = entry({ actionIds: ['ext_after'] });
      const registry = buildSlackInteractiveActionRegistry([], [hostile, survivor], NO_RESERVED);

      expect(registry.problems).toHaveLength(1);
      expect(registry.problems[0]).toContain('contributed entry 0');
      expect(registry.problems[0]).toContain('boom');
      expect(registry.find('ext_after')).toBe(survivor);
    });

    it('numbers each problem by the entry position and keeps going after one', () => {
      const good = entry({ actionIds: ['ext_good'] });
      const registry = buildSlackInteractiveActionRegistry([], [null, good, { actionIds: ['ext_x'] }], NO_RESERVED);

      expect(registry.problems).toEqual([
        'contributed entry 0 is not an object',
        'contributed entry 2 has no handle function',
      ]);
      expect(registry.find('ext_good')).toBe(good);
    });
  });

  describe('core wins', () => {
    const core = [entry({ actionIds: ['core_approve'], actionIdPrefixes: ['core_link_'] })];
    const reserved = { ids: ['reserved_id'], prefixes: ['reserved_prefix_'] };

    it.each([
      ['an equal id', { actionIds: ['core_approve'] }, 'core_approve'],
      ['an id a core prefix covers', { actionIds: ['core_link_view'] }, 'core_link_view'],
      ['a prefix covering a core id', { actionIdPrefixes: ['core_'] }, 'core_'],
      ['a prefix equal to a core prefix', { actionIdPrefixes: ['core_link_'] }, 'core_link_'],
      ['a prefix that extends a core prefix', { actionIdPrefixes: ['core_link_more_'] }, 'core_link_more_'],
      ['a prefix that a core prefix extends', { actionIdPrefixes: ['core_l'] }, 'core_l'],
      ['an equal reserved id', { actionIds: ['reserved_id'] }, 'reserved_id'],
      ['an id a reserved prefix covers', { actionIds: ['reserved_prefix_x'] }, 'reserved_prefix_x'],
      ['a prefix covering a reserved id', { actionIdPrefixes: ['reserved_'] }, 'reserved_'],
      [
        'a prefix that extends a reserved prefix',
        { actionIdPrefixes: ['reserved_prefix_deep_'] },
        'reserved_prefix_deep_',
      ],
    ])('leaves out an entry with %s, naming it', (_label, claims, named) => {
      const contributed = entry(claims);
      const registry = buildSlackInteractiveActionRegistry(core, [contributed], reserved);

      expect(registry.problems).toHaveLength(1);
      expect(registry.problems[0]).toContain(`"${named}"`);
      expect(registry.problems[0]).toContain('a core or reserved action');
      expect(registry.find(named)).not.toBe(contributed);
    });

    it('does not route an id of a rejected entry to it, and leaves its non-clashing ids out too', () => {
      const rejected = entry({ actionIds: ['ext_fine', 'core_approve'] });
      const registry = buildSlackInteractiveActionRegistry(core, [rejected], reserved);

      expect(registry.find('core_approve')).toBe(core[0]);
      expect(registry.find('ext_fine')).toBeUndefined();
    });

    it('lets an entry with no overlap register next to core and reserved actions', () => {
      const clear = entry({ actionIds: ['ext_ok'], actionIdPrefixes: ['ext_menu_'] });
      const registry = buildSlackInteractiveActionRegistry(core, [clear], reserved);

      expect(registry.problems).toEqual([]);
      expect(registry.find('ext_ok')).toBe(clear);
    });
  });

  describe('contributed against contributed', () => {
    it.each<[string, Claims, Claims]>([
      ['equal ids', { actionIds: ['ext_same'] }, { actionIds: ['ext_same'] }],
      ['an id covered by an earlier prefix', { actionIdPrefixes: ['ext_group_'] }, { actionIds: ['ext_group_one'] }],
      ['a prefix covering an earlier id', { actionIds: ['ext_group_one'] }, { actionIdPrefixes: ['ext_group_'] }],
      ['a prefix extending an earlier prefix', { actionIdPrefixes: ['ext_a_'] }, { actionIdPrefixes: ['ext_a_b_'] }],
      ['a prefix an earlier prefix extends', { actionIdPrefixes: ['ext_a_b_'] }, { actionIdPrefixes: ['ext_a_'] }],
    ])('keeps the first entry and leaves the later one out on %s', (_label, firstClaims, laterClaims) => {
      const first = entry(firstClaims);
      const later = entry({ ...laterClaims, actionIds: [...(laterClaims.actionIds ?? []), 'ext_later_only'] });
      const registry = buildSlackInteractiveActionRegistry([], [first, later], NO_RESERVED);

      expect(registry.problems).toHaveLength(1);
      expect(registry.problems[0]).toContain('contributed entry 1');
      expect(registry.problems[0]).toContain('earlier contributed entry');
      expect(registry.find('ext_later_only')).toBeUndefined();
      const firstClaimed = firstClaims.actionIds?.[0] ?? `${firstClaims.actionIdPrefixes?.[0]}x`;
      expect(registry.find(firstClaimed)).toBe(first);
    });

    it('does not let a left-out entry hold its other ids', () => {
      const invalid = entry({ actionIds: ['ext_held', 'Bad Id'] });
      const valid = entry({ actionIds: ['ext_held'] });
      const registry = buildSlackInteractiveActionRegistry([], [invalid, valid], NO_RESERVED);

      expect(registry.problems).toHaveLength(1);
      expect(registry.find('ext_held')).toBe(valid);
    });

    it('lets two entries with disjoint claims both register', () => {
      const a = entry({ actionIds: ['ext_one'] });
      const b = entry({ actionIdPrefixes: ['other_menu_'] });
      const registry = buildSlackInteractiveActionRegistry([], [a, b], NO_RESERVED);

      expect(registry.problems).toEqual([]);
      expect(registry.find('ext_one')).toBe(a);
      expect(registry.find('other_menu_1')).toBe(b);
    });
  });

  describe('core handlers', () => {
    it.each([
      ['equal ids', { actionIds: ['same_id'] }, { actionIds: ['same_id'] }],
      ['an id covered by a prefix', { actionIdPrefixes: ['same_'] }, { actionIds: ['same_id'] }],
      ['a prefix covering an id', { actionIds: ['same_id'] }, { actionIdPrefixes: ['same_'] }],
      ['nested prefixes', { actionIdPrefixes: ['same_'] }, { actionIdPrefixes: ['same_deeper_'] }],
    ])('throws when two core handlers clash on %s', (_label, first, second) => {
      expect(() => buildSlackInteractiveActionRegistry([entry(first), entry(second)], [], NO_RESERVED)).toThrow(
        /Core Slack interactive .* clashes with another core handler/
      );
    });

    it.each([
      ['an equal id', { actionIds: ['app_home_help'] }],
      ['an id a reserved prefix covers', { actionIds: ['menu_item'] }],
      ['a prefix covering a reserved id', { actionIdPrefixes: ['app_home_'] }],
    ])('throws when a core handler clashes with a reserved action on %s', (_label, claims) => {
      const reserved = { ids: ['app_home_help'], prefixes: ['menu_'] };

      expect(() => buildSlackInteractiveActionRegistry([entry(claims)], [], reserved)).toThrow(
        /Core Slack interactive .* clashes with a reserved action/
      );
    });

    it('does not count one handler claiming an id and a covering prefix as a clash', () => {
      const both = entry({ actionIds: ['group_one'], actionIdPrefixes: ['group_'] });

      expect(() => buildSlackInteractiveActionRegistry([both], [], NO_RESERVED)).not.toThrow();
    });
  });
});
