import Option from '@mui/joy/Option';
import Select from '@mui/joy/Select';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { ModelServerView } from '@shared/modelServers';

function note(server: ModelServerView): string | null {
  if (server.local) return null;
  if (server.health.state === 'unreachable') return 'Unreachable';
  if (server.health.state === 'credentials') return 'Needs credentials';
  if (server.health.state === 'refused') return 'Refused';
  if (server.kind !== 'ollama') return 'List only';
  return server.access === 'chat' ? 'Chat only' : null;
}

/** Which server Curated, Explore and Installed act on: "This computer" or a saved model server. */
export function ServerSwitcher({
  servers,
  value,
  onChange,
}: {
  servers: ModelServerView[];
  value: string;
  onChange: (serverId: string) => void;
}) {
  return (
    <Select
      size="sm"
      value={value}
      onChange={(_event, next) => next && onChange(next)}
      renderValue={selected => servers.find(server => server.id === selected?.value)?.name ?? ''}
      aria-label="Model server"
      sx={{ minWidth: 200, maxWidth: 280 }}
      slotProps={{ button: { 'data-testid': 'models-server-select' } }}
    >
      {servers.map(server => {
        const extra = note(server);
        return (
          <Option key={server.id} value={server.id} data-testid={`models-server-option-${server.id}`}>
            <Stack direction="row" spacing={1} alignItems="baseline" sx={{ minWidth: 0 }}>
              <Typography level="body-sm" noWrap>
                {server.name}
              </Typography>
              {extra && (
                <Typography level="body-xs" textColor="text.tertiary">
                  {extra}
                </Typography>
              )}
            </Stack>
          </Option>
        );
      })}
    </Select>
  );
}
