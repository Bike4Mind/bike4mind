import { useCallback, useEffect, useMemo, useState } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import IconButton from '@mui/joy/IconButton';
import Input from '@mui/joy/Input';
import Option from '@mui/joy/Option';
import Select from '@mui/joy/Select';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Switch from '@mui/joy/Switch';
import Typography from '@mui/joy/Typography';
import type { RecentFolder } from '@shared/chat';
import {
  type ClaudeCodeSourceView,
  PERMISSION_LISTS,
  type PermissionList,
  type PermissionRuleLists,
  type PermissionRuleView,
  type PermissionScope,
  type PermissionsState,
} from '@shared/permissions';
import { ChevronIcon } from './icons';

const LIST_LABEL: Record<PermissionList, string> = { allow: 'Allow', ask: 'Ask', deny: 'Deny' };
const LIST_COLOR: Record<PermissionList, 'success' | 'warning' | 'danger'> = {
  allow: 'success',
  ask: 'warning',
  deny: 'danger',
};
const USER_SCOPE = 'user';

export function permissionsSummary(state: PermissionsState | null): string {
  if (!state) return 'Allow, ask and deny rules for tool calls';
  const own = state.user.length + state.projects.reduce((total, project) => total + project.rules.length, 0);
  const shared = state.shareClaudeCode
    ? state.claudeCode.reduce((total, source) => total + source.rules.filter(rule => !rule.problem).length, 0)
    : 0;
  return `${own} desktop rule${own === 1 ? '' : 's'}${state.shareClaudeCode ? `, ${shared} shared from Claude Code` : ''}`;
}

function toLists(rules: readonly PermissionRuleView[]): PermissionRuleLists {
  const lists: PermissionRuleLists = { allow: [], ask: [], deny: [] };
  for (const { rule, list } of rules) if (!lists[list].includes(rule)) lists[list].push(rule);
  return lists;
}

function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length > 3 ? `.../${parts.slice(-3).join('/')}` : path;
}

function ruleCount(count: number): string {
  return `${count} rule${count === 1 ? '' : 's'}`;
}

function CollapseToggle({
  open,
  onToggle,
  name,
  testId,
}: {
  open: boolean;
  onToggle: () => void;
  name: string;
  testId: string;
}) {
  return (
    <IconButton
      size="sm"
      variant="plain"
      color="neutral"
      aria-expanded={open}
      aria-label={`${open ? 'Hide' : 'Show'} ${name}`}
      onClick={onToggle}
      data-testid={testId}
    >
      <ChevronIcon open={open} />
    </IconButton>
  );
}

export function usePermissions() {
  const [state, setState] = useState<PermissionsState | null>(null);
  useEffect(() => {
    let live = true;
    window.b4m.permissions
      .getState()
      .then(next => live && setState(next))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return [state, setState] as const;
}

function ListSelect({
  value,
  onChange,
  testId,
}: {
  value: PermissionList;
  onChange: (list: PermissionList) => void;
  testId: string;
}) {
  return (
    <Select
      size="sm"
      value={value}
      onChange={(_event, next) => next && onChange(next)}
      sx={{ minWidth: 88 }}
      slotProps={{ button: { 'data-testid': testId } }}
    >
      {PERMISSION_LISTS.map(list => (
        <Option key={list} value={list}>
          {LIST_LABEL[list]}
        </Option>
      ))}
    </Select>
  );
}

function RuleRow({
  view,
  onSave,
  onRemove,
}: {
  view: PermissionRuleView;
  onSave: (next: PermissionRuleView) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Stack direction="row" spacing={1} alignItems="center" data-testid="permissions-rule-row" data-rule={view.rule}>
      <ListSelect
        value={view.list}
        onChange={list => onSave({ rule: view.rule, list })}
        testId="permissions-rule-list-select"
      />
      {draft === null ? (
        <Stack sx={{ flex: 1, minWidth: 0 }}>
          <Typography level="body-sm" fontFamily="monospace" sx={{ overflowWrap: 'anywhere' }}>
            {view.rule}
          </Typography>
          {view.problem && (
            <Typography level="body-xs" color="danger" data-testid="permissions-rule-problem">
              Not applied: {view.problem}
            </Typography>
          )}
        </Stack>
      ) : (
        <Input
          size="sm"
          value={draft}
          autoFocus
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && draft.trim()) {
              onSave({ rule: draft.trim(), list: view.list });
              setDraft(null);
            }
            if (event.key === 'Escape') setDraft(null);
          }}
          sx={{ flex: 1, fontFamily: 'monospace' }}
          slotProps={{ input: { 'data-testid': 'permissions-rule-edit-input' } }}
        />
      )}
      {draft === null ? (
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          onClick={() => setDraft(view.rule)}
          data-testid="permissions-rule-edit-btn"
        >
          Edit
        </Button>
      ) : (
        <Button
          size="sm"
          variant="soft"
          disabled={!draft.trim()}
          onClick={() => {
            onSave({ rule: draft.trim(), list: view.list });
            setDraft(null);
          }}
          data-testid="permissions-rule-save-btn"
        >
          Save
        </Button>
      )}
      <Button size="sm" variant="plain" color="danger" onClick={onRemove} data-testid="permissions-rule-remove-btn">
        Remove
      </Button>
    </Stack>
  );
}

/**
 * Settings > Permissions: the desktop's own rules, editable, and Claude Code's, read-only.
 *
 * Every change goes through main, which refuses a rule that does not parse; nothing the model
 * can call reaches these channels.
 */
export function PermissionsSettings({
  state,
  onState,
}: {
  state: PermissionsState | null;
  onState: (state: PermissionsState) => void;
}) {
  const [folders, setFolders] = useState<RecentFolder[]>([]);
  const [scopeKey, setScopeKey] = useState<string>(USER_SCOPE);
  const [draft, setDraft] = useState('');
  const [draftList, setDraftList] = useState<PermissionList>('allow');
  const [error, setError] = useState<string | null>(null);
  const [desktopOpen, setDesktopOpen] = useState(true);

  useEffect(() => {
    window.b4m.chat
      .listRecentFolders()
      .then(setFolders)
      .catch(() => undefined);
  }, []);

  const projectChoices = useMemo(() => {
    const directories = new Set([
      ...(state?.projects.map(project => project.directory) ?? []),
      ...folders.map(folder => folder.path),
    ]);
    return [...directories];
  }, [state, folders]);

  const scope: PermissionScope = scopeKey === USER_SCOPE ? { kind: 'user' } : { kind: 'project', directory: scopeKey };
  const rules = useMemo(
    () =>
      scopeKey === USER_SCOPE
        ? (state?.user ?? [])
        : (state?.projects.find(project => project.directory === scopeKey)?.rules ?? []),
    [state, scopeKey]
  );

  const save = useCallback(
    async (next: PermissionRuleView[], target: PermissionScope = scope) => {
      const result = await window.b4m.permissions.setRules(target, toLists(next));
      if (result.ok) {
        setError(null);
        onState(result.state);
        return true;
      }
      setError(result.error);
      return false;
    },
    [scope, onState]
  );

  if (!state) {
    return (
      <Typography level="body-sm" data-testid="permissions-loading">
        Loading rules...
      </Typography>
    );
  }

  const add = async () => {
    const rule = draft.trim();
    if (!rule) return;
    if (await save([...rules.filter(each => each.rule !== rule), { rule, list: draftList }])) setDraft('');
  };

  const copyToDesktop = (view: PermissionRuleView) =>
    save([...state.user.filter(each => each.rule !== view.rule), { rule: view.rule, list: view.list }], {
      kind: 'user',
    });

  return (
    <Stack spacing={2} data-testid="permissions-settings">
      <Typography level="body-xs" textColor="text.tertiary">
        Rules use Claude Code's syntax, e.g. Bash(git status:*), Read(~/notes/**), WebFetch(domain:example.com),
        mcp__server__tool. Deny beats ask, and ask beats allow, whichever list a rule comes from. The approval mode
        under the message box still decides everything no rule names.
      </Typography>

      <Stack spacing={1}>
        <Stack direction="row" spacing={1} alignItems="center">
          <CollapseToggle
            open={desktopOpen}
            onToggle={() => setDesktopOpen(open => !open)}
            name="desktop rules"
            testId="permissions-desktop-toggle-btn"
          />
          <Typography level="title-sm">Desktop rules</Typography>
          <Typography
            level="body-xs"
            textColor="text.tertiary"
            sx={{ flex: 1 }}
            data-testid="permissions-desktop-count"
          >
            {ruleCount(rules.length)}
          </Typography>
          <Select
            size="sm"
            value={scopeKey}
            onChange={(_event, next) => next && setScopeKey(next)}
            sx={{ maxWidth: 280 }}
            slotProps={{ button: { 'data-testid': 'permissions-scope-select' } }}
          >
            <Option value={USER_SCOPE}>Every project</Option>
            {projectChoices.map(directory => (
              <Option key={directory} value={directory} title={directory}>
                {shortPath(directory)}
              </Option>
            ))}
          </Select>
        </Stack>

        {!desktopOpen ? null : rules.length === 0 ? (
          <Typography level="body-sm" textColor="text.tertiary" data-testid="permissions-empty">
            No rules here yet.
          </Typography>
        ) : (
          <Stack spacing={0.75}>
            {rules.map((view, index) => (
              <RuleRow
                key={`${view.list}:${view.rule}`}
                view={view}
                onSave={next => void save(rules.map((each, at) => (at === index ? next : each)))}
                onRemove={() => void save(rules.filter((_each, at) => at !== index))}
              />
            ))}
          </Stack>
        )}

        <Stack direction="row" spacing={1} alignItems="center">
          <ListSelect value={draftList} onChange={setDraftList} testId="permissions-add-list-select" />
          <Input
            size="sm"
            placeholder="Bash(gh pr view:*)"
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') void add();
            }}
            sx={{ flex: 1, fontFamily: 'monospace' }}
            slotProps={{ input: { 'aria-label': 'New rule', 'data-testid': 'permissions-add-input' } }}
          />
          <Button size="sm" disabled={!draft.trim()} onClick={() => void add()} data-testid="permissions-add-btn">
            Add
          </Button>
        </Stack>
        {error && (
          <Typography level="body-xs" color="danger" data-testid="permissions-error">
            {error}
          </Typography>
        )}
      </Stack>

      <Stack spacing={1}>
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography level="title-sm" sx={{ flex: 1 }}>
            Claude Code rules
          </Typography>
          <Typography level="body-xs" textColor="text.tertiary">
            Use them here
          </Typography>
          <Switch
            size="sm"
            checked={state.shareClaudeCode}
            onChange={event => void window.b4m.permissions.setSharing(event.target.checked).then(onState)}
            slotProps={{
              input: {
                'aria-label': "Use Claude Code's permission rules",
                'data-testid': 'permissions-sharing-switch',
              },
            }}
          />
        </Stack>
        <Typography level="body-xs" textColor="text.tertiary">
          Read from Claude Code's settings files and never changed here. A project's own files may allow something only
          once you trust the project; an untrusted project's deny and ask rules still apply.
        </Typography>

        {state.claudeCode.map(source => (
          <SourceCard
            key={source.id}
            source={source}
            shared={state.shareClaudeCode}
            isCopied={view => state.user.some(each => each.rule === view.rule && each.list === view.list)}
            onCopy={view => void copyToDesktop(view)}
          />
        ))}
      </Stack>
    </Stack>
  );
}

/** One Claude Code settings file. Closed by default: a long-lived settings file can hold dozens of rules. */
function SourceCard({
  source,
  shared,
  isCopied,
  onCopy,
}: {
  source: ClaudeCodeSourceView;
  shared: boolean;
  isCopied: (view: PermissionRuleView) => boolean;
  onCopy: (view: PermissionRuleView) => void;
}) {
  const [open, setOpen] = useState(false);
  const hasDetails = source.rules.length > 0 || source.additionalDirectories.length > 0;
  return (
    <Sheet
      variant="soft"
      sx={{ borderRadius: 'sm', p: 1, opacity: shared ? 1 : 0.55 }}
      data-testid="permissions-source"
      data-source={source.id}
    >
      <Stack direction="row" spacing={1} alignItems="center">
        {hasDetails && (
          <CollapseToggle
            open={open}
            onToggle={() => setOpen(current => !current)}
            name={`rules from ${source.label}`}
            testId="permissions-source-toggle-btn"
          />
        )}
        <Chip size="sm" variant="outlined" data-testid="permissions-source-badge">
          {source.label}
        </Chip>
        <Typography level="body-xs" fontFamily="monospace" title={source.path} noWrap sx={{ flex: 1, minWidth: 0 }}>
          {source.path}
        </Typography>
        {source.status === 'loaded' ? (
          <Typography level="body-xs" textColor="text.tertiary" data-testid="permissions-source-count">
            {ruleCount(source.rules.length)}
          </Typography>
        ) : (
          <Typography level="body-xs" textColor="text.tertiary">
            {source.status === 'missing' ? 'Not found' : 'Could not be read'}
          </Typography>
        )}
      </Stack>
      {source.note && (
        <Typography level="body-xs" color="warning" sx={{ mt: 0.5 }} data-testid="permissions-source-note">
          {source.note}
        </Typography>
      )}
      {open && (
        <>
          <Stack spacing={0.5} sx={{ mt: 0.75 }}>
            {source.rules.map(view => (
              <Stack
                key={`${view.list}:${view.rule}`}
                direction="row"
                spacing={1}
                alignItems="center"
                sx={{ opacity: view.problem ? 0.5 : 1 }}
                data-testid="permissions-shared-rule"
                data-unmapped={view.problem ? 'true' : undefined}
              >
                <Chip size="sm" variant="soft" color={LIST_COLOR[view.list]}>
                  {LIST_LABEL[view.list]}
                </Chip>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography level="body-sm" fontFamily="monospace" sx={{ overflowWrap: 'anywhere' }}>
                    {view.rule}
                  </Typography>
                  {view.problem && (
                    <Typography level="body-xs" textColor="text.tertiary">
                      Ignored: {view.problem}
                    </Typography>
                  )}
                </Box>
                {!view.problem && (
                  <Button
                    size="sm"
                    variant="plain"
                    color="neutral"
                    disabled={isCopied(view)}
                    onClick={() => onCopy(view)}
                    data-testid="permissions-copy-btn"
                  >
                    Copy to desktop rules
                  </Button>
                )}
              </Stack>
            ))}
          </Stack>
          {source.additionalDirectories.length > 0 && (
            <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>
              Additional directories (not shared here): {source.additionalDirectories.join(', ')}
            </Typography>
          )}
        </>
      )}
    </Sheet>
  );
}
