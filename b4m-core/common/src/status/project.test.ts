import { describe, expect, it } from 'vitest';
import {
  NOW,
  SENTINEL_DATE,
  SENTINEL_NUMBER,
  SENTINEL_PREFIX,
  collectSentinelStrings,
  fillFromSchema,
  isoSeconds,
  makeComponent,
  makeIncident,
  makeProjectionInput,
  makeRichInput,
  makeRuntime,
  minutesAgo,
} from './__fixtures__/statusFixtures';
import { StatusProjectionError, projectPublicSnapshot, type ProjectedSnapshot } from './project';
import {
  StatusComponentAdminSchema,
  StatusIncidentAdminSchema,
  StatusIncidentUpdateAdminSchema,
} from './schemas.admin';
import { PUBLIC_INCIDENT_ID_PATTERN, type StatusComponentDoc, type StatusIncidentDoc } from './types';

const bytes = (snapshot: ProjectedSnapshot) =>
  JSON.stringify([
    snapshot.summary,
    snapshot.incidentsIndex,
    snapshot.incidentFiles,
    snapshot.archives,
    snapshot.uptime,
    snapshot.summaryLadderSteps,
    snapshot.warnings,
  ]);

const filledComponent = (overrides: Partial<StatusComponentDoc>): StatusComponentDoc => ({
  ...(fillFromSchema(StatusComponentAdminSchema) as StatusComponentDoc),
  ...overrides,
});

const filledIncident = (overrides: Partial<StatusIncidentDoc>): StatusIncidentDoc => ({
  ...(fillFromSchema(StatusIncidentAdminSchema) as StatusIncidentDoc),
  ...overrides,
});

describe('value-level sentinel', () => {
  const sentinelComponent = filledComponent({
    key: `${SENTINEL_PREFIX}contributed_key`,
    contributorId: `${SENTINEL_PREFIX}contributor_id`,
    publicSlug: 'chat',
    source: 'contributed',
    name: 'Chat',
    description: 'Public description',
    group: 'platform',
    order: 2,
    visibility: 'public',
    monitoring: 'probed',
    externallyMonitored: false,
    retiredAt: undefined,
    parentKey: undefined,
    probeKeys: [`${SENTINEL_PREFIX}probe_target_https://10.9.8.7/health`],
    vendor: {
      key: `${SENTINEL_PREFIX}vendor_key`,
      displayName: `${SENTINEL_PREFIX}vendor_name`,
      statusPageUrl: 'https://vendor.sentinel.invalid',
      publicNaming: false,
    },
  });
  const pendingComponent = filledComponent({
    key: `${SENTINEL_PREFIX}pending_key`,
    publicSlug: `${SENTINEL_PREFIX}pending_slug`,
    visibility: 'admin',
    retiredAt: undefined,
    parentKey: undefined,
  });
  const hiddenComponent = filledComponent({ visibility: 'hidden', retiredAt: undefined, parentKey: undefined });
  const retiredComponent = filledComponent({
    visibility: 'public',
    publicSlug: 'retired-row',
    group: 'platform',
    parentKey: undefined,
  });

  const publicUpdate = {
    ...(fillFromSchema(StatusIncidentUpdateAdminSchema) as StatusIncidentDoc['updates'][number]),
    updateId: 'u_pub',
    at: minutesAgo(20),
    status: 'investigating' as const,
    body: 'We are investigating. Next update in 30 minutes.',
    editedAt: minutesAgo(10),
    authorId: `${SENTINEL_PREFIX}staff_name_jane.doe@sentinel.invalid`,
  };

  const securityIncident = filledIncident({
    publicId: 'k3v9q2m7xa',
    kind: 'incident',
    published: true,
    source: 'break_glass',
    classification: 'security',
    title: 'Sign in is degraded',
    status: 'investigating',
    impact: 'major',
    components: [{ componentKey: sentinelComponent.key, impact: 'partial_outage' }],
    startedAt: minutesAgo(30),
    updatedAt: minutesAgo(10),
    resolvedAt: undefined,
    scheduledStartAt: undefined,
    scheduledEndAt: undefined,
    completedEarlyAt: undefined,
    cancelledAt: undefined,
    retracted: undefined,
    updates: [publicUpdate],
    postmortem: { url: 'https://docs.example.com/pm', body: 'Public postmortem.', publishedAt: minutesAgo(5) },
  });
  const draft = filledIncident({
    publicId: 'dr4ftdr4ft',
    published: false,
    title: `${SENTINEL_PREFIX}draft_title`,
    resolvedAt: undefined,
    retracted: undefined,
    components: [{ componentKey: sentinelComponent.key, impact: 'major_outage' }],
  });
  const retracted = filledIncident({
    publicId: 'retr4cted0',
    published: true,
    title: `${SENTINEL_PREFIX}retracted_title`,
    resolvedAt: undefined,
    components: [{ componentKey: sentinelComponent.key, impact: 'major_outage' }],
  });
  const adminInputs = [
    sentinelComponent,
    pendingComponent,
    hiddenComponent,
    retiredComponent,
    securityIncident,
    draft,
    retracted,
  ];

  const snapshot = projectPublicSnapshot(
    makeProjectionInput({
      components: [sentinelComponent, pendingComponent, hiddenComponent, retiredComponent].map(component => ({
        component,
        automaticState: 'partial_outage' as const,
      })),
      incidents: [securityIncident, draft, retracted],
      uptime: [
        {
          componentKey: sentinelComponent.key,
          uptime: 0.999,
          days: [
            {
              day: '2026-11-23',
              barCode: 'p',
              uptimeBp: 9_990,
              downtimeMinutes: 3,
              incidentIds: ['k3v9q2m7xa', 'dr4ftdr4ft', 'retr4cted0'],
            },
          ],
        },
        { componentKey: pendingComponent.key, uptime: 0.1, days: [] },
      ],
    })
  );
  const serialized = bytes(snapshot);

  it('fills every admin-only field with a sentinel, generated from the admin schema', () => {
    const sentinels = adminInputs.flatMap(input => collectSentinelStrings(input));
    expect(new Set(sentinels).size).toBeGreaterThan(40);
    for (const path of [
      'internalNotes[].body',
      'editHistory[].body',
      'breakGlass.journalKeys[]',
      'detection.probeKeys[]',
      'retracted.reason',
      'createdBy',
    ]) {
      expect(
        sentinels.some(value => value.includes(path)),
        path
      ).toBe(true);
    }
  });

  it('keeps every sentinel string out of every published file', () => {
    expect(snapshot.dropped).toEqual([]);
    const sentinels = new Set(adminInputs.flatMap(input => collectSentinelStrings(input)));
    for (const sentinel of sentinels) expect(serialized.includes(sentinel), `leaked ${sentinel}`).toBe(false);
    expect(serialized).not.toContain(SENTINEL_PREFIX);
  });

  it('keeps admin-only numbers, dates and enum values out of every published file', () => {
    expect(serialized).not.toContain(String(SENTINEL_NUMBER));
    expect(serialized).not.toContain(isoSeconds(SENTINEL_DATE));
    expect(serialized).not.toContain('2031-03-03');
    for (const word of [
      'break_glass',
      'auto_draft',
      'classification',
      'security',
      'contributorId',
      'componentKey',
      'authorId',
      'editHistory',
      'internalNotes',
    ]) {
      expect(serialized, word).not.toContain(word);
    }
  });

  it('still publishes the public values, so the check is not vacuous', () => {
    expect(snapshot.summary.components.map(c => c.slug)).toEqual(['chat']);
    expect(snapshot.summary.components[0]).toMatchObject({
      name: 'Chat',
      description: 'Public description',
      group: 'platform',
    });
    expect(snapshot.summary.activeIncidents[0]).toMatchObject({ id: 'k3v9q2m7xa', title: 'Sign in is degraded' });
    expect(snapshot.incidentFiles.k3v9q2m7xa.incident.updates[0]).toMatchObject({ id: 'u_pub', edited: true });
    expect(snapshot.incidentFiles.k3v9q2m7xa.postmortem?.url).toBe('https://docs.example.com/pm');
    expect(snapshot.uptime.components[0].slug).toBe('chat');
  });

  it('shows hidden, pending-publication and retired rows nowhere', () => {
    expect(snapshot.summary.components).toHaveLength(1);
    expect(snapshot.uptime.components).toHaveLength(1);
  });
});

describe('incident ids', () => {
  const published = makeIncident();
  const draft = makeIncident({ publicId: 'dr4ftdr4ft', published: false, title: 'Draft' });
  const retracted = makeIncident({
    publicId: 'retr4cted0',
    title: 'Retracted',
    retracted: { at: minutesAgo(1), by: 'a', reason: 'r' },
  });
  const resolved = makeIncident({
    publicId: 'r3solved01',
    status: 'resolved',
    resolvedAt: minutesAgo(5_000),
    startedAt: minutesAgo(6_000),
    updatedAt: minutesAgo(5_000),
  });
  const snapshot = projectPublicSnapshot(
    makeProjectionInput({
      incidents: [published, draft, retracted, resolved],
      uptime: [
        {
          componentKey: 'chat',
          uptime: 0.99,
          days: [
            {
              day: '2026-11-23',
              barCode: 'p',
              uptimeBp: 9_900,
              downtimeMinutes: 9,
              incidentIds: ['k3v9q2m7xa', 'dr4ftdr4ft', 'retr4cted0', 'unknown001'],
            },
          ],
        },
      ],
    })
  );

  it('every incident id in every file is a published, non-retracted id', () => {
    const allowed = new Set(['k3v9q2m7xa', 'r3solved01']);
    const ids = [
      ...snapshot.summary.activeIncidents.map(h => h.id),
      ...snapshot.summary.upcomingMaintenance.map(h => h.id),
      ...snapshot.incidentsIndex.incidents.map(r => r.id),
      ...Object.values(snapshot.archives).flatMap(a => a.incidents.map(r => r.id)),
      ...Object.keys(snapshot.incidentFiles),
      ...Object.values(snapshot.incidentFiles).map(f => f.incident.id),
    ];
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(allowed.has(id), id).toBe(true);
      expect(PUBLIC_INCIDENT_ID_PATTERN.test(id)).toBe(true);
    }
  });

  it('rollup incident ids are filtered to the ids being written, and only counted', () => {
    expect(snapshot.uptime.components[0].days[0]).toEqual(['p', 9_900, 9, 1]);
    const text = JSON.stringify(snapshot.uptime);
    for (const id of ['k3v9q2m7xa', 'dr4ftdr4ft', 'retr4cted0', 'unknown001']) expect(text).not.toContain(id);
  });

  it('drafts and retracted incidents have no per-incident file and no archive row', () => {
    expect(Object.keys(snapshot.incidentFiles).sort()).toEqual(['k3v9q2m7xa', 'r3solved01']);
    expect(JSON.stringify(snapshot.archives)).not.toContain('dr4ftdr4ft');
    expect(JSON.stringify(snapshot)).not.toContain('Retracted');
  });
});

describe('component state', () => {
  const rowFor = (overrides: Parameters<typeof makeRuntime>[0], incidents: StatusIncidentDoc[] = []) =>
    projectPublicSnapshot(makeProjectionInput({ components: [makeRuntime(overrides)], incidents })).summary
      .components[0];

  it('reports the automatic state as base and state', () => {
    expect(rowFor({ automaticState: 'major_outage' })).toMatchObject({
      state: 'major_outage',
      baseState: 'major_outage',
    });
  });

  it('a pin replaces the base, a suppression reads operational', () => {
    expect(rowFor({ automaticState: 'major_outage', activePin: 'degraded' })).toMatchObject({
      state: 'degraded',
      baseState: 'degraded',
    });
    expect(rowFor({ automaticState: 'major_outage', suppressed: true })).toMatchObject({
      state: 'operational',
      baseState: 'operational',
    });
  });

  it('an incident floors the displayed state but not the base, and never masks a worse base', () => {
    expect(rowFor({ automaticState: 'operational' }, [makeIncident()])).toMatchObject({
      state: 'partial_outage',
      baseState: 'operational',
    });
    expect(
      rowFor({ automaticState: 'major_outage' }, [
        makeIncident({ components: [{ componentKey: 'chat', impact: 'degraded' }] }),
      ])
    ).toMatchObject({
      state: 'major_outage',
    });
  });

  it('a pin below an incident still shows the incident impact', () => {
    expect(
      rowFor({ automaticState: 'major_outage', suppressed: true }, [
        makeIncident({ components: [{ componentKey: 'chat', impact: 'degraded' }] }),
      ])
    ).toMatchObject({
      state: 'degraded',
      baseState: 'operational',
    });
  });

  it('resolved, draft and retracted incidents do not floor', () => {
    const resolved = makeIncident({ status: 'resolved', resolvedAt: minutesAgo(1) });
    const draft = makeIncident({ published: false });
    const retracted = makeIncident({ retracted: { at: minutesAgo(1), by: 'a', reason: 'r' } });
    expect(rowFor({}, [resolved, draft, retracted]).state).toBe('operational');
  });

  it('flags automated detection only for a probed row nobody has covered', () => {
    expect(rowFor({ automaticState: 'partial_outage' }).autoDetected).toBe(true);
    expect(rowFor({ automaticState: 'major_outage' }).autoDetected).toBe(true);
    expect(rowFor({ automaticState: 'degraded' }).autoDetected).toBe(false);
    expect(rowFor({ automaticState: 'major_outage' }, [makeIncident()]).autoDetected).toBe(false);
    expect(rowFor({ automaticState: 'major_outage', suppressed: true }).autoDetected).toBe(false);
    expect(rowFor({ automaticState: 'major_outage', activePin: 'operational' }).autoDetected).toBe(false);
    expect(rowFor({ automaticState: 'major_outage', component: { monitoring: 'manual' } }).autoDetected).toBe(false);
  });

  it('labels a row under active maintenance without changing its state', () => {
    const maintenance = makeIncident({
      publicId: 'mnt0000001',
      kind: 'maintenance',
      status: 'scheduled',
      impact: 'none',
      scheduledStartAt: minutesAgo(10),
      scheduledEndAt: new Date(NOW.getTime() + 3_600_000),
      components: [{ componentKey: 'chat', impact: 'degraded' }],
    });
    const row = rowFor({ automaticState: 'major_outage' }, [maintenance]);
    expect(row.maintenance).toEqual({
      incidentId: 'mnt0000001',
      endsAt: isoSeconds(new Date(NOW.getTime() + 3_600_000)),
    });
    expect(row.state).toBe('major_outage');
  });
});

describe('vendor rows', () => {
  const vendorRuntime = ({ component, ...rest }: Parameters<typeof makeRuntime>[0] = {}) =>
    makeRuntime({
      component: {
        key: 'provider-example',
        publicSlug: 'example-provider',
        name: 'Example Provider',
        group: 'platform',
        monitoring: 'vendor',
        vendor: {
          key: 'example',
          displayName: 'Example Provider',
          statusPageUrl: 'https://status.example.org',
          publicNaming: true,
        },
        ...component,
      },
      automaticState: 'operational',
      vendorFeed: { indicator: 'major', checkedAt: minutesAgo(2) },
      ...rest,
    });
  const project = (runtime = vendorRuntime(), incidents: StatusIncidentDoc[] = []) =>
    projectPublicSnapshot(makeProjectionInput({ components: [runtime], incidents }));

  it('derives state from the vendor feed only', () => {
    const row = project().summary.components[0];
    expect(row).toMatchObject({ state: 'partial_outage', baseState: 'partial_outage', monitoring: 'vendor' });
    expect(row.vendor).toEqual({
      statusPageUrl: 'https://status.example.org',
      upstream: { indicator: 'major', checkedAt: isoSeconds(minutesAgo(2)) },
    });
  });

  it('our own signals never change the public vendor row', () => {
    const noisy = project(
      vendorRuntime({ automaticState: 'major_outage', vendorFeed: { indicator: 'none', checkedAt: minutesAgo(1) } })
    );
    expect(noisy.summary.components[0].state).toBe('operational');
  });

  it('a failing or missing feed reads unknown, and a human incident floors it', () => {
    expect(project(vendorRuntime({ vendorFeed: null })).summary.components[0]).toMatchObject({
      state: 'unknown',
      vendor: { upstream: null },
    });
    const incident = makeIncident({ components: [{ componentKey: 'provider-example', impact: 'degraded' }] });
    expect(project(vendorRuntime({ vendorFeed: null }), [incident]).summary.components[0].state).toBe('degraded');
  });

  it('is dropped, and reported, unless the vendor is publicly named', () => {
    const hidden = project(
      vendorRuntime({
        component: {
          vendor: { key: 'x', displayName: 'X', statusPageUrl: 'https://status.example.org', publicNaming: false },
        },
      })
    );
    expect(hidden.summary.components).toEqual([]);
    expect(hidden.dropped).toEqual([{ file: 'summary', ref: 'provider-example', reason: 'vendor_not_public' }]);
  });

  it('is dropped when the vendor page is not https', () => {
    const insecure = project(
      vendorRuntime({
        component: {
          vendor: { key: 'x', displayName: 'X', statusPageUrl: 'http://status.example.org', publicNaming: true },
        },
      })
    );
    expect(insecure.summary.components).toEqual([]);
    expect(insecure.dropped[0].reason).toBe('schema');
  });
});

describe('visibility, groups and children', () => {
  it('omits admin, hidden and retired rows and groups with no public row', () => {
    const rich = makeRichInput({
      components: [
        makeRuntime(),
        makeRuntime({ component: { key: 'media', publicSlug: 'media', visibility: 'admin', group: 'providers' } }),
        makeRuntime({
          component: { key: 'old', publicSlug: 'old-row', visibility: 'public', retiredAt: minutesAgo(5) },
        }),
        makeRuntime({ component: { key: 'secret', publicSlug: 'secret-row', visibility: 'hidden' } }),
      ],
    });
    const { summary } = projectPublicSnapshot(rich);
    expect(summary.components.map(c => c.slug)).toEqual(['chat']);
    expect(summary.groups).toEqual([{ slug: 'platform', name: 'Platform', order: 0 }]);
  });

  it('drops a row whose group is not in the catalog and reports it', () => {
    const result = projectPublicSnapshot(
      makeProjectionInput({ components: [makeRuntime({ component: { group: 'nowhere' } })] })
    );
    expect(result.summary.components).toEqual([]);
    expect(result.dropped).toEqual([{ file: 'summary', ref: 'chat', reason: 'unknown_group' }]);
  });

  it('drops a group whose name fails the text policy and its rows with it', () => {
    const result = projectPublicSnapshot(
      makeProjectionInput({ groups: [{ slug: 'platform', name: 'Plat\nform', order: 0 }] })
    );
    expect(result.summary.groups).toEqual([]);
    expect(result.dropped).toContainEqual({ file: 'summary', ref: 'platform', reason: 'group_text_policy' });
    expect(result.dropped).toContainEqual({ file: 'summary', ref: 'chat', reason: 'unknown_group' });
  });

  it('nests child rows under a public parent, and drops them when the parent is not public', () => {
    const { summary } = projectPublicSnapshot(makeRichInput());
    const parent = summary.components.find(c => c.slug === 'sign-in');
    expect(parent?.children.map(c => c.slug)).toEqual(['sign-in-google']);
    expect(summary.components.some(c => c.slug === 'sign-in-google')).toBe(false);

    const orphaned = projectPublicSnapshot(
      makeProjectionInput({
        components: [makeRuntime({ component: { key: 'kid', publicSlug: 'kid-row', parentKey: 'missing-parent' } })],
      })
    );
    expect(orphaned.summary.components).toEqual([]);
    expect(orphaned.dropped[0].reason).toBe('parent_not_public');
  });

  it('orders by group, then order, then slug', () => {
    const { summary } = projectPublicSnapshot(makeRichInput());
    expect(summary.components.map(c => c.slug)).toEqual(['chat', 'sign-in', 'example-provider']);
    expect(summary.groups.map(g => g.slug)).toEqual(['platform', 'providers']);
  });

  it('overall state is the worst visible state, children included', () => {
    expect(projectPublicSnapshot(makeRichInput()).summary.overall.state).toBe('partial_outage');
    const quiet = makeRichInput({ incidents: [] });
    expect(projectPublicSnapshot(quiet).summary.overall.state).toBe('degraded');
    expect(projectPublicSnapshot(makeProjectionInput({ components: [] })).summary.overall.state).toBe('unknown');
  });

  it('passes the offline notice and the freshness fields through', () => {
    const { summary } = projectPublicSnapshot(
      makeProjectionInput({
        notice: 'offline',
        probesTrigger: 'manual',
        breakglassAppliedSeq: 12,
        externalIgnoredUntil: minutesAgo(-5),
      })
    );
    expect(summary).toMatchObject({
      schemaVersion: 1,
      seq: 48211,
      generatedAt: '2026-11-23T19:40:07Z',
      probesAsOf: isoSeconds(minutesAgo(1)),
      probesTrigger: 'manual',
      staleAfterSeconds: 240,
      hardStaleAfterSeconds: 900,
      breakglassAppliedSeq: 12,
      externalIgnoredUntil: isoSeconds(minutesAgo(-5)),
      overall: { notice: 'offline' },
    });
  });
});

describe('incidents', () => {
  const project = (incidents: StatusIncidentDoc[], extra = {}) =>
    projectPublicSnapshot(makeProjectionInput({ incidents, ...extra }));

  it('lists active incidents by severity and shows the latest three updates newest first', () => {
    const many = makeIncident({
      updates: Array.from({ length: 5 }, (_, n) => ({
        updateId: `u_${n}`,
        at: minutesAgo(50 - n),
        status: 'investigating' as const,
        body: `Update ${n}`,
        authorId: 'a',
        editHistory: [],
      })),
    });
    const minor = makeIncident({
      publicId: 'mino0r0001',
      impact: 'minor',
      title: 'Minor',
      components: [{ componentKey: 'chat', impact: 'degraded' }],
      updatedAt: minutesAgo(1),
    });
    const { summary, incidentFiles } = project([minor, many]);
    expect(summary.activeIncidents.map(h => h.id)).toEqual(['k3v9q2m7xa', 'mino0r0001']);
    expect(summary.activeIncidents[0].latestUpdates.map(u => u.id)).toEqual(['u_4', 'u_3', 'u_2']);
    expect(summary.activeIncidents[0].updateCount).toBe(5);
    expect(incidentFiles.k3v9q2m7xa.incident.updates.map(u => u.id)).toEqual(['u_0', 'u_1', 'u_2', 'u_3', 'u_4']);
  });

  it('truncates summary bodies at 1,000 characters and flags it; the incident file keeps the full text', () => {
    const body = 'word '.repeat(400).trim();
    const { summary, incidentFiles } = project([
      makeIncident({
        updates: [
          { updateId: 'u_long', at: minutesAgo(5), status: 'investigating', body, authorId: 'a', editHistory: [] },
        ],
      }),
    ]);
    const head = summary.activeIncidents[0].latestUpdates[0];
    expect(Array.from(head.body).length).toBeLessThanOrEqual(1_000);
    expect(head.truncated).toBe(true);
    const full = incidentFiles.k3v9q2m7xa.incident.updates[0];
    expect(full.truncated).toBe(false);
    expect(full.body).toBe(body);
  });

  it('marks edited updates and keeps edit history out', () => {
    const { incidentFiles } = project([
      makeIncident({
        updates: [
          {
            updateId: 'u_e',
            at: minutesAgo(5),
            status: 'investigating',
            body: 'Fixed text',
            authorId: 'a',
            editedAt: minutesAgo(2),
            editHistory: [{ at: minutesAgo(2), editorId: 'e', body: 'Typo text' }],
          },
        ],
      }),
    ]);
    expect(incidentFiles.k3v9q2m7xa.incident.updates[0].edited).toBe(true);
    expect(JSON.stringify(incidentFiles)).not.toContain('Typo text');
  });

  it('shows only public slugs for listed components', () => {
    const { summary } = project([
      makeIncident({
        components: [
          { componentKey: 'chat', impact: 'degraded' },
          { componentKey: 'not-public', impact: 'major_outage' },
        ],
      }),
    ]);
    expect(summary.activeIncidents[0].components).toEqual([{ slug: 'chat', impact: 'degraded' }]);
  });

  it('strips links off the allowlist from bodies and from the postmortem', () => {
    const { incidentFiles } = project([
      makeIncident({
        status: 'resolved',
        resolvedAt: minutesAgo(1),
        updates: [
          {
            updateId: 'u_l',
            at: minutesAgo(5),
            status: 'resolved',
            body: 'See [docs](https://docs.example.com/a) and [other](https://evil.example.net/b).',
            authorId: 'a',
            editHistory: [],
          },
        ],
        postmortem: {
          url: 'https://evil.example.net/pm',
          body: 'Read [this](javascript:alert(1)).',
          publishedAt: minutesAgo(1),
        },
      }),
    ]);
    const file = incidentFiles.k3v9q2m7xa;
    expect(file.incident.updates[0].body).toBe('See [docs](https://docs.example.com/a) and other.');
    expect(file.postmortem).toEqual({ url: null, body: 'Read this.', publishedAt: isoSeconds(minutesAgo(1)) });
  });

  it('publishes a postmortem only once it has a publication time', () => {
    const { incidentFiles } = project([makeIncident({ postmortem: { body: 'Draft postmortem' } })]);
    expect(incidentFiles.k3v9q2m7xa.postmortem).toBeNull();
    expect(JSON.stringify(incidentFiles)).not.toContain('Draft postmortem');
  });

  it('drops only the incident that fails the text policy, and reports it', () => {
    const bad = makeIncident({ publicId: 'bad0000001', title: 'Affecting {component}' });
    const worse = makeIncident({
      publicId: 'bad0000002',
      updates: [
        {
          updateId: 'u_x',
          at: minutesAgo(1),
          status: 'investigating',
          body: 'Next update {nextUpdate}',
          authorId: 'a',
          editHistory: [],
        },
      ],
    });
    const result = project([bad, worse, makeIncident()]);
    expect(result.summary.activeIncidents.map(h => h.id)).toEqual(['k3v9q2m7xa']);
    expect(Object.keys(result.incidentFiles)).toEqual(['k3v9q2m7xa']);
    expect(result.dropped).toEqual([
      { file: 'incident', ref: 'bad0000001', reason: 'text_policy' },
      { file: 'incident', ref: 'bad0000002', reason: 'text_policy' },
    ]);
  });

  it('drops an incident with an id that is not a public id', () => {
    const result = project([makeIncident({ publicId: 'inc_123' })]);
    expect(result.dropped).toEqual([{ file: 'incident', ref: 'inc_123', reason: 'schema' }]);
    expect(result.incidentFiles).toEqual({});
  });

  it('drops an incident over the 200,000 character public text budget', () => {
    const body = 'x'.repeat(4_000);
    const updates = Array.from({ length: 50 }, (_, n) => ({
      updateId: `u_${n}`,
      at: minutesAgo(100 - n),
      status: 'investigating' as const,
      body,
      authorId: 'a',
      editHistory: [],
    }));
    expect(project([makeIncident({ updates })]).dropped[0].reason).toBe('text_budget');
    expect(project([makeIncident({ updates: updates.slice(0, 49) })]).dropped).toEqual([]);
  });

  it('drops an incident over the 200 update cap', () => {
    const updates = Array.from({ length: 201 }, (_, n) => ({
      updateId: `u_${n}`,
      at: minutesAgo(300 - n),
      status: 'investigating' as const,
      body: 'x',
      authorId: 'a',
      editHistory: [],
    }));
    expect(project([makeIncident({ updates })]).dropped[0].reason).toBe('too_many_updates');
  });

  it('fails the whole projection on an unusable page title or app url', () => {
    expect(() =>
      projectPublicSnapshot(
        makeProjectionInput({ page: { title: '', appUrl: 'https://app.example.com', linkHosts: [] } })
      )
    ).toThrow(StatusProjectionError);
    expect(() =>
      projectPublicSnapshot(
        makeProjectionInput({ page: { title: 'Status', appUrl: 'http://app.example.com', linkHosts: [] } })
      )
    ).toThrow(StatusProjectionError);
  });
});

describe('maintenance', () => {
  const maintenance = (overrides: Partial<StatusIncidentDoc>) =>
    makeIncident({
      publicId: 'mnt0000001',
      kind: 'maintenance',
      status: 'scheduled',
      impact: 'none',
      components: [{ componentKey: 'chat', impact: 'degraded' }],
      startedAt: minutesAgo(900),
      ...overrides,
    });
  const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);
  const project = (docs: StatusIncidentDoc[]) =>
    projectPublicSnapshot(makeProjectionInput({ incidents: docs })).summary;

  it('lists upcoming maintenance for seven days, soonest first', () => {
    const summary = project([
      maintenance({ publicId: 'later00001', scheduledStartAt: at(100), scheduledEndAt: at(101) }),
      maintenance({ publicId: 'soon000001', scheduledStartAt: at(5), scheduledEndAt: at(6) }),
      maintenance({ publicId: 'farout0001', scheduledStartAt: at(24 * 8), scheduledEndAt: at(24 * 8 + 1) }),
    ]);
    expect(summary.upcomingMaintenance.map(h => h.id)).toEqual(['soon000001', 'later00001']);
    expect(summary.activeIncidents).toEqual([]);
  });

  it('puts in-progress maintenance in active incidents from the schedule', () => {
    const summary = project([maintenance({ scheduledStartAt: at(-1), scheduledEndAt: at(1) })]);
    expect(summary.activeIncidents.map(h => h.id)).toEqual(['mnt0000001']);
    expect(summary.upcomingMaintenance).toEqual([]);
  });

  it('leaves out cancelled, completed-early and finished windows', () => {
    const summary = project([
      maintenance({ publicId: 'cancel0001', scheduledStartAt: at(2), scheduledEndAt: at(3), status: 'cancelled' }),
      maintenance({
        publicId: 'early00001',
        scheduledStartAt: at(-1),
        scheduledEndAt: at(1),
        status: 'completed',
        completedEarlyAt: at(-0.5),
      }),
      maintenance({ publicId: 'past000001', scheduledStartAt: at(-3), scheduledEndAt: at(-2) }),
    ]);
    expect(summary.activeIncidents).toEqual([]);
    expect(summary.upcomingMaintenance).toEqual([]);
  });
});

describe('incidents.json, archive and uptime', () => {
  it('keeps a 90 day window and files older incidents by UTC year in the archive', () => {
    const old = makeIncident({
      publicId: 'old0000001',
      status: 'resolved',
      startedAt: new Date('2025-06-01T00:00:00Z'),
      resolvedAt: new Date('2025-06-01T01:00:00Z'),
      updatedAt: new Date('2025-06-01T01:00:00Z'),
    });
    const recent = makeIncident({
      publicId: 'rec0000001',
      status: 'resolved',
      startedAt: minutesAgo(1_000),
      resolvedAt: minutesAgo(900),
      updatedAt: minutesAgo(900),
    });
    const { incidentsIndex, archives } = projectPublicSnapshot(
      makeProjectionInput({ incidents: [old, recent, makeIncident()] })
    );
    expect(incidentsIndex).toMatchObject({ schemaVersion: 1, windowDays: 90 });
    expect(incidentsIndex.incidents.map(r => r.id)).toEqual(['k3v9q2m7xa', 'rec0000001']);
    expect(Object.keys(archives).sort()).toEqual(['2025', '2026']);
    expect(archives['2025'].incidents.map(r => r.id)).toEqual(['old0000001']);
    expect(archives['2026'].incidents.map(r => r.id)).toEqual(['k3v9q2m7xa', 'rec0000001']);
  });

  it('index rows carry no updates and no bodies', () => {
    const { incidentsIndex } = projectPublicSnapshot(makeProjectionInput({ incidents: [makeIncident()] }));
    expect(Object.keys(incidentsIndex.incidents[0])).not.toContain('latestUpdates');
    expect(JSON.stringify(incidentsIndex)).not.toContain('investigating slow');
  });

  it('publishes uptime only for probed, public first-party rows and floors the fraction', () => {
    const { uptime } = projectPublicSnapshot(
      makeRichInput({
        uptime: [
          {
            componentKey: 'chat',
            uptime: 0.999996,
            days: [{ day: '2026-11-23', barCode: 'o', uptimeBp: 9_999, downtimeMinutes: 0.4, incidentIds: [] }],
          },
          { componentKey: 'provider-example', uptime: 0.5, days: [] },
          { componentKey: 'missing', uptime: 0.5, days: [] },
          {
            componentKey: 'sign-in',
            uptime: null,
            days: [{ day: '2026-11-22', barCode: 'n', uptimeBp: null, downtimeMinutes: 0, incidentIds: [] }],
          },
        ],
      })
    );
    expect(uptime.components.map(c => c.slug)).toEqual(['chat', 'sign-in']);
    expect(uptime.components[0].uptime).toBe(0.99999);
    expect(uptime.components[1].uptime).toBeNull();
    expect(uptime.components[0].days).toEqual([
      ['n', null, 0, 0],
      ['o', 9_999, 0, 0],
    ]);
    expect(uptime.components[1].days).toEqual([
      ['n', null, 0, 0],
      ['n', null, 0, 0],
    ]);
    expect(uptime.from).toBe('2026-11-22');
    expect(uptime.to).toBe('2026-11-23');
  });

  it('keeps an exact 1 for zero downtime and defaults the window when there are no rows', () => {
    const { uptime } = projectPublicSnapshot(
      makeProjectionInput({ uptime: [{ componentKey: 'chat', uptime: 1, days: [] }] })
    );
    expect(uptime.components[0].uptime).toBe(1);
    expect(uptime.to).toBe('2026-11-23');
    expect(uptime.from).toBe('2026-08-26');
  });

  it('drops a malformed uptime row and reports it', () => {
    const result = projectPublicSnapshot(
      makeProjectionInput({
        uptime: [
          {
            componentKey: 'chat',
            uptime: 0.9,
            days: [{ day: 'today', barCode: 'o', uptimeBp: 1, downtimeMinutes: 0, incidentIds: [] }],
          },
        ],
      })
    );
    expect(result.uptime.components).toEqual([]);
    expect(result.dropped).toEqual([{ file: 'uptime', ref: 'chat', reason: 'schema' }]);
  });
});

describe('size bounding', () => {
  it('applies the summary ladder under a small cap and reports each step', () => {
    const body = 'word '.repeat(190).trim();
    const incidents = Array.from({ length: 30 }, (_, n) =>
      makeIncident({
        publicId: `a${String(n).padStart(9, '0')}`,
        updatedAt: minutesAgo(n),
        updates: Array.from({ length: 4 }, (_, u) => ({
          updateId: `u_${n}_${u}`,
          at: minutesAgo(100 + u),
          status: 'investigating' as const,
          body,
          authorId: 'a',
          editHistory: [],
        })),
      })
    );
    const result = projectPublicSnapshot(makeProjectionInput({ incidents, summarySizeCap: 12_000 }));
    expect(result.summaryLadderSteps.length).toBeGreaterThan(0);
    expect(result.warnings).toContain('summary_size_ladder_step_2');
    expect(Object.keys(result.incidentFiles)).toHaveLength(30);
    expect(Object.values(result.incidentFiles)[0].incident.updates).toHaveLength(4);
  });

  it('is deterministic', () => {
    expect(bytes(projectPublicSnapshot(makeRichInput()))).toBe(bytes(projectPublicSnapshot(makeRichInput())));
  });

  it('leaves the component list untouched when no products or extras exist', () => {
    const a = projectPublicSnapshot(makeRichInput());
    const b = projectPublicSnapshot(makeRichInput({ incidents: [...makeRichInput().incidents].reverse() }));
    expect(JSON.stringify(a.summary.components)).toBe(JSON.stringify(b.summary.components));
  });

  it('keeps component descriptions to the policy limit', () => {
    const result = projectPublicSnapshot(
      makeProjectionInput({ components: [makeRuntime({ component: makeComponent({ description: 'x'.repeat(201) }) })] })
    );
    expect(result.dropped).toEqual([{ file: 'summary', ref: 'chat', reason: 'text_policy' }]);
  });
});

const projectOne = (incident: StatusIncidentDoc, extra: Parameters<typeof makeProjectionInput>[0] = {}) =>
  projectPublicSnapshot(makeProjectionInput({ incidents: [incident], ...extra }));
const updateOf = (body: string): StatusIncidentDoc['updates'][number] => ({
  updateId: 'u_long',
  at: minutesAgo(20),
  status: 'investigating',
  body,
  authorId: 'author-1',
  editHistory: [],
});

describe('bodies that outgrow the schema cap keep the incident', () => {
  it('truncates an update whose escaped form is over the cap and flags it', () => {
    const snapshot = projectOne(makeIncident({ updates: [updateOf('a_b '.repeat(1_000).trim())] }));
    expect(snapshot.dropped).toEqual([]);
    expect(snapshot.summary.activeIncidents.map(h => h.id)).toEqual(['k3v9q2m7xa']);
    expect(snapshot.summary.activeIncidents[0].impact).toBe('major');
    expect(snapshot.summary.overall.state).toBe('partial_outage');
    const update = snapshot.incidentFiles.k3v9q2m7xa.incident.updates[0];
    expect(update.truncated).toBe(true);
    expect(update.body.length).toBeLessThanOrEqual(4_000);
    expect(snapshot.warnings).toContain('update_body_truncated_k3v9q2m7xa');
  });

  it('keeps an incident whose update has as many emoji as the limit allows', () => {
    const snapshot = projectOne(makeIncident({ updates: [updateOf('\u{1F600}'.repeat(4_000))] }));
    expect(snapshot.dropped).toEqual([]);
    const update = snapshot.incidentFiles.k3v9q2m7xa.incident.updates[0];
    expect(update.truncated).toBe(true);
    expect(update.body.length).toBeLessThanOrEqual(4_000);
    expect(snapshot.summary.activeIncidents[0].latestUpdates[0].body.length).toBeLessThanOrEqual(1_000);
  });

  it('does not flag a body that fits', () => {
    const snapshot = projectOne(makeIncident());
    expect(snapshot.incidentFiles.k3v9q2m7xa.incident.updates[0].truncated).toBe(false);
    expect(snapshot.warnings.some(w => w.startsWith('update_body_truncated'))).toBe(false);
  });

  it('still drops an incident whose over-long update also has a hard text error', () => {
    const snapshot = projectOne(makeIncident({ updates: [updateOf(`{todo} ${'x'.repeat(5_000)}`)] }));
    expect(snapshot.dropped).toEqual([{ file: 'incident', ref: 'k3v9q2m7xa', reason: 'text_policy' }]);
  });

  it('drops only an over-long postmortem body, keeping the incident and its link', () => {
    const postmortem = { url: 'https://docs.example.com/pm', body: '_'.repeat(15_000), publishedAt: minutesAgo(5) };
    const snapshot = projectOne(makeIncident({ postmortem }));
    expect(snapshot.dropped).toEqual([{ file: 'incident', ref: 'k3v9q2m7xa', reason: 'postmortem_body_too_long' }]);
    expect(snapshot.incidentFiles.k3v9q2m7xa.postmortem).toEqual({
      url: 'https://docs.example.com/pm',
      body: null,
      publishedAt: isoSeconds(minutesAgo(5)),
    });
    expect(snapshot.summary.activeIncidents).toHaveLength(1);
  });

  it('publishes a null postmortem when neither a link nor a body survives', () => {
    const tooLong = projectOne(makeIncident({ postmortem: { body: '_'.repeat(15_000), publishedAt: minutesAgo(5) } }));
    expect(tooLong.incidentFiles.k3v9q2m7xa.postmortem).toBeNull();
    const blockedLink = projectOne(
      makeIncident({ postmortem: { url: 'https://evil.example.net/pm', publishedAt: minutesAgo(5) } })
    );
    expect(blockedLink.incidentFiles.k3v9q2m7xa.postmortem).toBeNull();
  });
});

describe('one public set of components', () => {
  const parent = (visibility: 'public' | 'admin') =>
    makeRuntime({ component: { key: 'root', publicSlug: 'root-row', visibility, order: 1 } });
  const child = (key: string, parentKey: string, order: number) =>
    makeRuntime({ component: { key, publicSlug: `${key}-row`, parentKey, order } });
  const uptimeRow = (componentKey: string) => ({
    componentKey,
    uptime: 0.9999,
    days: [{ day: '2026-11-23', barCode: 'o' as const, uptimeBp: 9_999, downtimeMinutes: 0, incidentIds: [] }],
  });
  const listing = (...keys: string[]) =>
    makeIncident({ components: keys.map(componentKey => ({ componentKey, impact: 'degraded' as const })) });

  it('keeps a child of a non-public parent out of uptime and incident components', () => {
    const snapshot = projectPublicSnapshot(
      makeProjectionInput({
        components: [parent('admin'), child('kid', 'root', 2)],
        incidents: [listing('kid')],
        uptime: [uptimeRow('kid')],
      })
    );
    expect(snapshot.summary.components).toEqual([]);
    expect(snapshot.dropped).toContainEqual({ file: 'summary', ref: 'kid', reason: 'parent_not_public' });
    expect(snapshot.uptime.components).toEqual([]);
    expect(snapshot.incidentFiles.k3v9q2m7xa.incident.components).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toContain('kid-row');
  });

  it('reports a grandchild and keeps its slug out of every file', () => {
    const snapshot = projectPublicSnapshot(
      makeProjectionInput({
        components: [parent('public'), child('kid', 'root', 2), child('grandkid', 'kid', 3)],
        incidents: [listing('root', 'kid', 'grandkid')],
        uptime: [uptimeRow('root'), uptimeRow('kid'), uptimeRow('grandkid')],
      })
    );
    expect(snapshot.dropped).toContainEqual({ file: 'summary', ref: 'grandkid', reason: 'nested_too_deep' });
    expect(snapshot.summary.components.map(c => c.children.map(k => k.slug))).toEqual([['kid-row']]);
    expect(snapshot.uptime.components.map(c => c.slug)).toEqual(['kid-row', 'root-row']);
    expect(snapshot.incidentFiles.k3v9q2m7xa.incident.components.map(c => c.slug)).toEqual(['root-row', 'kid-row']);
    expect(JSON.stringify(snapshot)).not.toContain('grandkid-row');
  });

  it('keeps a row that failed its text policy out of incidents and uptime', () => {
    const snapshot = projectPublicSnapshot(
      makeProjectionInput({
        components: [makeRuntime({ component: { name: '{unfilled}' } })],
        incidents: [listing('chat')],
        uptime: [uptimeRow('chat')],
      })
    );
    expect(snapshot.dropped).toContainEqual({ file: 'summary', ref: 'chat', reason: 'text_policy' });
    expect(snapshot.uptime.components).toEqual([]);
    expect(snapshot.incidentFiles.k3v9q2m7xa.incident.components).toEqual([]);
  });
});

describe('malformed records are dropped, the rest publishes', () => {
  const invalid = new Date('not a date');

  it('drops an incident with an Invalid Date and keeps the others', () => {
    const snapshot = projectPublicSnapshot(
      makeProjectionInput({
        incidents: [
          makeIncident({ publicId: 'bad0000001', startedAt: invalid }),
          makeIncident({ publicId: 'bad0000002', updates: [{ ...updateOf('x'), at: invalid }] }),
          makeIncident({ publicId: 'good000001' }),
        ],
      })
    );
    expect(snapshot.dropped).toEqual([
      { file: 'incident', ref: 'bad0000001', reason: 'invalid_date' },
      { file: 'incident', ref: 'bad0000002', reason: 'invalid_date' },
    ]);
    expect(snapshot.summary.activeIncidents.map(h => h.id)).toEqual(['good000001']);
  });

  it('drops a component with an Invalid Date vendor feed and keeps the rest', () => {
    const rich = makeRichInput();
    const snapshot = projectPublicSnapshot({
      ...rich,
      components: rich.components.map(runtime =>
        runtime.vendorFeed ? { ...runtime, vendorFeed: { ...runtime.vendorFeed, checkedAt: invalid } } : runtime
      ),
    });
    expect(snapshot.dropped).toContainEqual({ file: 'summary', ref: 'provider-example', reason: 'invalid_date' });
    expect(snapshot.summary.components.map(c => c.slug)).toContain('chat');
  });

  it('drops a malformed group and the rows under it', () => {
    const groups = [
      { slug: 'platform', name: 'Platform', order: 0 },
      { slug: 'Bad Slug', name: 'Broken', order: 1 },
      { slug: 'nameless', name: undefined as unknown as string, order: 2 },
      { slug: 'fractional', name: 'Fractional', order: 1.5 },
    ];
    const snapshot = projectPublicSnapshot(makeProjectionInput({ groups }));
    expect(snapshot.dropped.map(d => d.reason)).toEqual(['group_schema', 'group_schema', 'group_schema']);
    expect(snapshot.summary.groups).toEqual([{ slug: 'platform', name: 'Platform', order: 0 }]);
  });

  it('trims linkHosts to the cap, with a warning, and ignores entries that are not hosts', () => {
    const hosts = Array.from({ length: 250 }, (_, n) => `h${String(n).padStart(3, '0')}.example.com`);
    const snapshot = projectPublicSnapshot(
      makeProjectionInput({
        page: {
          title: 'Example Status',
          appUrl: 'https://app.example.com',
          linkHosts: [...hosts, 42 as never, 'x'.repeat(300)],
        },
      })
    );
    expect(snapshot.summary.page.linkHosts).toHaveLength(200);
    expect(snapshot.warnings).toEqual(expect.arrayContaining(['link_hosts_trimmed', 'link_hosts_invalid_entries']));
    const bad = projectPublicSnapshot(
      makeProjectionInput({
        page: { title: 'Example Status', appUrl: 'https://app.example.com', linkHosts: 'x' as never },
      })
    );
    expect(bad.summary.page.linkHosts).toEqual([]);
  });

  it('refuses an Invalid Date that the whole publish depends on', () => {
    expect(() => projectPublicSnapshot(makeProjectionInput({ probesAsOf: invalid }))).toThrow(StatusProjectionError);
  });
});

describe('uptime file bounds', () => {
  const dayRow = (offset: number) => {
    const day = new Date(NOW.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
    return { day, barCode: 'o' as const, uptimeBp: 10_000, downtimeMinutes: 0, incidentIds: [] };
  };

  it('keeps only days inside the 90 day window', () => {
    const days = Array.from({ length: 130 }, (_, n) => dayRow(n));
    const { uptime } = projectPublicSnapshot(
      makeProjectionInput({ uptime: [{ componentKey: 'chat', uptime: 1, days }] })
    );
    expect(uptime.components[0].days).toHaveLength(90);
    expect(uptime.from).toBe(dayRow(89).day);
    expect(uptime.to).toBe(dayRow(0).day);
    const future = projectPublicSnapshot(
      makeProjectionInput({ uptime: [{ componentKey: 'chat', uptime: 1, days: [dayRow(-3), dayRow(0)] }] })
    );
    expect(future.uptime.components[0].days).toHaveLength(1);
  });

  it('warns when uptime.json is over its size cap and still publishes it', () => {
    const count = 200;
    const days = Array.from({ length: 90 }, (_, n) => ({ ...dayRow(n), uptimeBp: 9_876, downtimeMinutes: 123 }));
    const runtimes = Array.from({ length: count }, (_, n) =>
      makeRuntime({ component: { key: `row-${n}`, publicSlug: `row-${String(n).padStart(3, '0')}`, order: n } })
    );
    const snapshot = projectPublicSnapshot(
      makeProjectionInput({
        components: runtimes,
        summarySizeCap: 1_000_000,
        uptime: runtimes.map(r => ({ componentKey: r.component.key, uptime: 0.99, days })),
      })
    );
    expect(snapshot.uptime.components).toHaveLength(count);
    expect(snapshot.warnings).toContain('uptime_over_cap');
  });

  it('does not warn for a normal file', () => {
    expect(projectPublicSnapshot(makeRichInput()).warnings).not.toContain('uptime_over_cap');
  });
});

describe('a status that does not belong to the kind', () => {
  it('drops an incident-kind entry marked completed and a maintenance marked investigating', () => {
    const snapshot = projectPublicSnapshot(
      makeProjectionInput({
        incidents: [
          makeIncident({ publicId: 'wrongkind1', status: 'completed' }),
          makeIncident({ publicId: 'wrongkind2', kind: 'maintenance', status: 'investigating' }),
        ],
      })
    );
    expect(snapshot.dropped.map(d => [d.ref, d.reason])).toEqual([
      ['wrongkind1', 'schema'],
      ['wrongkind2', 'schema'],
    ]);
    expect(snapshot.summary.activeIncidents).toEqual([]);
  });
});

describe('value-level sentinel over the rich input', () => {
  let counter = 0;
  const hidden: string[] = [];
  const hiddenNumbers: number[] = [];
  const visibleText: string[] = [];
  const secret = (label: string) => {
    const value = `${SENTINEL_PREFIX}${label}_${++counter}`;
    hidden.push(value);
    return value;
  };
  const secretNumber = () => {
    const value = 7_770_000 + ++counter;
    hiddenNumbers.push(value);
    return value;
  };
  const shown = (label: string) => {
    const value = `${label}${++counter}marker`;
    visibleText.push(value);
    return value;
  };

  const rich = makeRichInput();
  const dressed = (runtime: (typeof rich.components)[number]) => ({
    ...runtime,
    component: {
      ...runtime.component,
      name: shown('Name'),
      description: shown('Description'),
      contributorId: secret('contributor'),
      probeKeys: [secret('probe'), secret('probe')],
      hysteresis: { fail: secretNumber(), recover: secretNumber() },
      vendor: runtime.component.vendor && {
        ...runtime.component.vendor,
        key: secret('vendor_key'),
        displayName: secret('vendor_name'),
      },
    },
  });
  const hiddenRow = makeRuntime({
    component: {
      key: secret('row_key'),
      publicSlug: 'hidden-row',
      name: secret('row_name'),
      visibility: 'admin',
      contributorId: secret('row_contributor'),
    },
  });
  const incidents = rich.incidents.map(doc => ({
    ...doc,
    title: shown('Title'),
    updates: doc.updates.map(update => ({
      ...update,
      body: shown('Body'),
      authorId: secret('author'),
      impactChange: { from: 'none' as const, to: 'minor' as const },
      componentChanges: [{ componentKey: secret('changed_key'), from: null, to: 'degraded' as const }],
      editHistory: [{ at: minutesAgo(1), editorId: secret('editor'), body: secret('old_body') }],
    })),
    internalNotes: [{ at: minutesAgo(2), authorId: secret('note_author'), body: secret('note') }],
    plannedMessages: { start: secret('planned'), end: secret('planned') },
    detection: { firstFailureAt: minutesAgo(40), probeKeys: [secret('detected')], upstream: secret('upstream') },
    breakGlass: {
      journalKeys: [secret('journal')],
      actorIds: [secret('actor')],
      firstWrittenAt: minutesAgo(30),
      backdateConfirmedBy: secret('confirmer'),
    },
    createdBy: secret('creator'),
    version: secretNumber(),
    postmortem: doc.postmortem && { ...doc.postmortem, body: shown('Postmortem') },
  }));
  const hiddenUptime = {
    componentKey: hiddenRow.component.key,
    uptime: 0.5,
    days: [
      {
        day: '2026-11-23',
        barCode: 'p' as const,
        uptimeBp: 5_000,
        downtimeMinutes: secretNumber(),
        incidentIds: [secret('incident_id')],
      },
    ],
  };
  const snapshot = projectPublicSnapshot({
    ...rich,
    components: [...rich.components.map(dressed), hiddenRow],
    incidents,
    uptime: [...(rich.uptime ?? []), hiddenUptime],
  });
  const serialized = bytes(snapshot);

  it('publishes the whole rich input without dropping a record', () => {
    expect(snapshot.dropped).toEqual([]);
    expect(snapshot.summary.components.some(c => c.vendor !== null)).toBe(true);
    expect(snapshot.summary.components.some(c => c.children.length > 0)).toBe(true);
    expect(snapshot.summary.components.some(c => c.maintenance !== null)).toBe(true);
    expect(Object.values(snapshot.incidentFiles).some(f => f.postmortem?.body)).toBe(true);
  });

  it('shows the text the spec makes public', () => {
    expect(visibleText.length).toBeGreaterThan(10);
    for (const text of visibleText) {
      expect(serialized, text).toContain(text);
    }
  });

  it('keeps every other string and number out of every published file', () => {
    expect(new Set(hidden).size).toBe(hidden.length);
    expect(hidden.length).toBeGreaterThan(40);
    for (const value of hidden) expect(serialized.includes(value), `leaked ${value}`).toBe(false);
    for (const value of hiddenNumbers) expect(serialized.includes(String(value)), `leaked ${value}`).toBe(false);
    expect(serialized).not.toContain('hidden-row');
  });
});

describe('a record that throws is dropped with a fixed reason, the rest publishes', () => {
  const healthyRuntime = makeRuntime({ component: { key: 'api', publicSlug: 'api', name: 'API', order: 3 } });
  const malformed = (component: Record<string, unknown>) =>
    makeRuntime({ component: { key: 'chat', ...component } as never });

  it('drops a component with a null description', () => {
    const snapshot = projectPublicSnapshot(
      makeProjectionInput({ components: [malformed({ description: null }), healthyRuntime] })
    );
    expect(snapshot.summary.components.map(c => c.slug)).toEqual(['api']);
    expect(snapshot.dropped).toEqual([{ file: 'summary', ref: 'chat', reason: 'malformed_record' }]);
  });

  it('drops a component with no name', () => {
    const snapshot = projectPublicSnapshot(
      makeProjectionInput({ components: [malformed({ name: undefined }), healthyRuntime] })
    );
    expect(snapshot.summary.components.map(c => c.slug)).toEqual(['api']);
    expect(snapshot.dropped).toEqual([{ file: 'summary', ref: 'chat', reason: 'malformed_record' }]);
  });

  it('drops an incident whose updates are null', () => {
    const snapshot = projectPublicSnapshot(
      makeProjectionInput({
        incidents: [makeIncident({ publicId: 'bad0000001', updates: null as never }), makeIncident()],
      })
    );
    expect(snapshot.summary.activeIncidents.map(h => h.id)).toEqual(['k3v9q2m7xa']);
    expect(snapshot.dropped).toEqual([{ file: 'incident', ref: 'bad0000001', reason: 'malformed_record' }]);
  });

  it('drops one uptime day whose incidentIds are null and keeps the other rows', () => {
    const day = (date: string, incidentIds: string[]) => ({
      day: date,
      barCode: 'o' as const,
      uptimeBp: 9_999,
      downtimeMinutes: 0,
      incidentIds,
    });
    const snapshot = projectPublicSnapshot(
      makeProjectionInput({
        components: [makeRuntime(), healthyRuntime],
        uptime: [
          {
            componentKey: 'chat',
            uptime: 0.99,
            days: [day('2026-11-22', []), day('2026-11-23', null as unknown as string[])],
          },
          { componentKey: 'api', uptime: 0.99, days: [day('2026-11-23', [])] },
        ],
      })
    );
    expect(snapshot.dropped).toEqual([{ file: 'uptime', ref: 'chat', reason: 'malformed_record' }]);
    expect(snapshot.uptime.components.map(c => c.slug)).toEqual(['api', 'chat']);
    const chat = snapshot.uptime.components.find(c => c.slug === 'chat');
    expect(chat?.days).toEqual([
      ['o', 9_999, 0, 0],
      ['n', null, 0, 0],
    ]);
  });

  it('drops an uptime row that is not an object and keeps the others', () => {
    const snapshot = projectPublicSnapshot(
      makeProjectionInput({
        uptime: [null as never, { componentKey: 'chat', uptime: null, days: [] }],
      })
    );
    expect(snapshot.dropped).toEqual([{ file: 'uptime', ref: '', reason: 'malformed_record' }]);
    expect(snapshot.uptime.components.map(c => c.slug)).toEqual(['chat']);
  });

  it('leaves out a component row that has no component object', () => {
    const snapshot = projectPublicSnapshot(
      makeProjectionInput({ components: [null as never, { state: 'operational' } as never, healthyRuntime] })
    );
    expect(snapshot.summary.components.map(c => c.slug)).toEqual(['api']);
  });

  it('keeps raising for an invalid top-level input', () => {
    expect(() => projectPublicSnapshot(makeProjectionInput({ now: new Date('nope') }))).toThrow(StatusProjectionError);
  });
});

describe('summary update bodies are cut at a token boundary', () => {
  it('does not leave half a link in the latest update', () => {
    const body = `${'a'.repeat(985)} [status page](https://app.example.com/x) and more`;
    const snapshot = projectPublicSnapshot(
      makeProjectionInput({
        incidents: [
          makeIncident({
            updates: [
              { updateId: 'u_cut', at: minutesAgo(5), status: 'investigating', body, authorId: 'a', editHistory: [] },
            ],
          }),
        ],
      })
    );
    const head = snapshot.summary.activeIncidents[0].latestUpdates[0];
    expect(head.truncated).toBe(true);
    expect(head.body.length).toBeLessThanOrEqual(1_000);
    expect(head.body.endsWith('\u2026')).toBe(true);
    expect(head.body).not.toMatch(/\[|\]\(/);
    expect(snapshot.incidentFiles.k3v9q2m7xa.incident.updates[0].body).toContain('[status page](');
  });
});

describe('headline for an incident that touches no component on the page', () => {
  const overallFor = (incidents: StatusIncidentDoc[], components = [makeRuntime()]) => {
    const summary = projectPublicSnapshot(makeProjectionInput({ incidents, components })).summary;
    return { overall: summary.overall.state, rows: summary.components.map(row => row.state) };
  };
  const critical = (overrides: Partial<StatusIncidentDoc> = {}) =>
    makeIncident({ impact: 'critical', components: [], ...overrides });

  it('an active critical incident with no components raises the headline, not the rows', () => {
    expect(overallFor([critical()])).toEqual({ overall: 'major_outage', rows: ['operational'] });
  });

  it('an incident listing only a component that is not public counts as touching none', () => {
    const hidden = makeRuntime({ component: { key: 'secret', publicSlug: 'secret', visibility: 'admin' } });
    const incident = critical({ components: [{ componentKey: 'secret', impact: 'major_outage' }] });
    expect(overallFor([incident], [makeRuntime(), hidden])).toEqual({
      overall: 'major_outage',
      rows: ['operational'],
    });
  });

  it('an incident that lists a component on the page contributes only that impact', () => {
    const incident = critical({ components: [{ componentKey: 'chat', impact: 'degraded' }] });
    expect(overallFor([incident])).toEqual({ overall: 'degraded', rows: ['degraded'] });
  });

  it('a resolved incident or an active maintenance with no components changes nothing', () => {
    const resolved = critical({ status: 'resolved', resolvedAt: minutesAgo(5) });
    const maintenance = makeIncident({
      publicId: 'mnt0000001',
      kind: 'maintenance',
      status: 'in_progress',
      impact: 'critical',
      components: [],
      scheduledStartAt: minutesAgo(10),
      scheduledEndAt: new Date(NOW.getTime() + 3_600_000),
    });
    expect(overallFor([resolved, maintenance])).toEqual({ overall: 'operational', rows: ['operational'] });
  });
});

describe('support address', () => {
  const body = 'Write to [email us](mailto:Support@Example.com) for help.';
  const detailBody = (page: ProjectionPage) =>
    Object.values(
      projectPublicSnapshot(
        makeProjectionInput({
          page,
          incidents: [
            makeIncident({
              updates: [{ ...makeIncident().updates[0], body }],
            }),
          ],
        })
      ).incidentFiles
    )[0].incident.updates[0].body;
  type ProjectionPage = ReturnType<typeof makeProjectionInput>['page'];
  const page = (supportEmail?: string | null): ProjectionPage => ({
    title: 'Example Status',
    appUrl: 'https://app.example.com',
    linkHosts: ['app.example.com'],
    ...(supportEmail === undefined ? {} : { supportEmail }),
  });

  it('keeps a mailto link to the support address, normalized to lowercase', () => {
    expect(detailBody(page('support@example.com'))).toContain('[email us](mailto:support@example.com)');
  });

  it('shows any other mailto, or any mailto without a support address, as plain text', () => {
    expect(detailBody(page('help@example.com'))).not.toContain('](mailto:');
    expect(detailBody(page(null))).not.toContain('](mailto:');
    expect(detailBody(page())).not.toContain('](mailto:');
  });

  it('publishes the cleaned address, or null with a warning when it is invalid', () => {
    const clean = projectPublicSnapshot(makeProjectionInput({ page: page('  Support@Example.com ') }));
    expect(clean.summary.page.supportEmail).toBe('support@example.com');
    expect(clean.warnings).not.toContain('support_email_invalid');
    for (const bad of ['nope', 'a@b', 'a@@b.com', `${'a'.repeat(65)}@example.com`, 42 as never]) {
      const out = projectPublicSnapshot(makeProjectionInput({ page: page(bad) }));
      expect(out.summary.page.supportEmail).toBeNull();
      expect(out.warnings).toContain('support_email_invalid');
    }
    expect(projectPublicSnapshot(makeProjectionInput()).summary.page.supportEmail).toBeNull();
  });
});
