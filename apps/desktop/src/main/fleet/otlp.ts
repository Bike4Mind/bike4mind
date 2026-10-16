import type { ActivityBatch, ActivityEvent } from './activityContract';

/**
 * Activity as OTLP/HTTP JSON logs, the shape Fleet's `/v1/logs` receiver parses.
 *
 * Must stay in sync with Fleet's `lib/bike4mind-desktop-otel.ts`: the service name, the event
 * names and every attribute key below are the wire contract.
 */
export const SERVICE_NAME = 'bike4mind-desktop';

export interface OtlpResource {
  appVersion: string;
  email: string | null;
  installId: string;
}

type OtlpValue = { stringValue: string } | { intValue: string };
type OtlpAttribute = { key: string; value: OtlpValue };

const str = (key: string, value: string): OtlpAttribute => ({ key, value: { stringValue: value } });
// OTLP JSON carries int64 as a decimal string.
const int = (key: string, value: number): OtlpAttribute => ({ key, value: { intValue: String(Math.trunc(value)) } });

function eventName(event: ActivityEvent): string {
  return `bike4mind_desktop.${event.type}`;
}

function attributes(event: ActivityEvent): OtlpAttribute[] {
  const base = [
    str('event.name', eventName(event)),
    str('event.id', event.eventId),
    str('session.id', event.sessionId),
    int('duration_ms', event.durationMs),
  ];
  if (event.type === 'tool') return [...base, str('tool.category', event.tool.type)];
  if (event.type === 'repository') {
    return [
      ...base,
      str('repository.owner', event.repository.owner),
      str('repository.name', event.repository.name),
      str('repository.action', event.repository.action),
    ];
  }
  return base;
}

function nanos(iso: string): string {
  return (BigInt(Date.parse(iso)) * 1_000_000n).toString();
}

/** One ExportLogsServiceRequest for a batch. Pure. */
export function toOtlpLogs(batch: ActivityBatch, resource: OtlpResource): unknown {
  const resourceAttributes = [
    str('service.name', SERVICE_NAME),
    str('service.version', resource.appVersion),
    ...(resource.email ? [str('user.email', resource.email)] : []),
    str('fleet.install.id', resource.installId),
  ];
  return {
    resourceLogs: [
      {
        resource: { attributes: resourceAttributes },
        scopeLogs: [
          {
            scope: { name: SERVICE_NAME, version: resource.appVersion },
            logRecords: batch.events.map(event => ({
              timeUnixNano: nanos(event.occurredAt),
              severityText: 'INFO',
              body: { stringValue: eventName(event) },
              attributes: attributes(event),
            })),
          },
        ],
      },
    ],
  };
}
