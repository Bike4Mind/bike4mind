type SourceHelp = {
  label: string;
  description: string;
};

const SOURCE_HELP: Record<string, SourceHelp> = {
  web: { label: 'Web app', description: 'Activity attributed to the browser app.' },
  desktop: { label: 'Desktop app', description: 'Activity attributed to the Bike4Mind desktop app.' },
  cli: {
    label: 'Command line (CLI)',
    description: 'Activity from the Bike4Mind command-line app, used in a terminal.',
  },
  api: { label: 'API', description: 'Requests made by other software using an API key.' },
  agent: { label: 'Agent', description: 'Activity performed by server-side AI agents and automations.' },
  system: { label: 'System', description: 'Activity performed by background jobs or internal scripts.' },
  manual: { label: 'Manual', description: 'An action started by a person, rather than triggered automatically.' },
  auto: {
    label: 'Automatic',
    description: 'An action triggered automatically by the app, without a person opening it.',
  },
  'badge-button': { label: 'Badge button', description: 'Opened from a button with a notification count badge.' },
};

export function getUsageSourceHelp(source: string): SourceHelp {
  const help = Object.hasOwn(SOURCE_HELP, source) ? SOURCE_HELP[source] : undefined;
  return (
    help ?? {
      label: source,
      description:
        'A source recorded by the feature that logged this event. It may identify an app, entry point, or trigger. No explanation is available for this value yet.',
    }
  );
}
