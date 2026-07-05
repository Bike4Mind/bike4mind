import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  ChipDelete,
  IconButton,
  Input,
  Sheet,
  Stack,
  Textarea,
  Tooltip,
  Typography,
} from '@mui/joy';
import SendIcon from '@mui/icons-material/Send';
import DeleteIcon from '@mui/icons-material/Delete';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import LocalOfferIcon from '@mui/icons-material/LocalOffer';
import { api } from '@client/app/contexts/ApiContext';
import { PREDEFINED_USER_TAGS } from '@bike4mind/common';
import { APP_NAME } from '@client/config/general'; // brand externalized
import { toast } from 'sonner';
import CopyButton from '../shared/CopyButton';
import { getTagColor } from '../shared/tagColors';

// --- Types ---

type RowStatus = 'draft' | 'sent' | 'failed';

interface DraftRow {
  id: string;
  email: string;
  first: string;
  last: string;
  credits: string;
  storage: string;
  tags: string[];
  status: RowStatus;
  error?: string;
}

interface ImportResult {
  success: boolean;
  email?: string;
  error?: string;
}

// --- Helpers ---

const createEmptyRow = (): DraftRow => ({
  id: crypto.randomUUID(),
  email: '',
  first: '',
  last: '',
  credits: '',
  storage: '',
  tags: [],
  status: 'draft',
});

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const validateRow = (row: DraftRow, allRows: DraftRow[]): string | undefined => {
  if (!row.email) return undefined; // empty row, skip
  if (!EMAIL_REGEX.test(row.email)) return 'Invalid email format';
  const dupes = allRows.filter(r => r.id !== row.id && r.email === row.email);
  if (dupes.length > 0) return 'Duplicate email in table';
  return undefined;
};

const parseCsvText = (text: string): Omit<DraftRow, 'id' | 'status'>[] => {
  const lines = text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);

  return lines.map(line => {
    // Support both comma and tab separated
    const sep = line.includes('\t') ? '\t' : ',';
    const values = line.split(sep).map(v => v.trim());

    return {
      email: values[0] || '',
      first: values[1] || '',
      last: values[2] || '',
      credits: values[3] || '',
      storage: values[4] || '',
      tags: values[5]
        ? values[5]
            .split(';')
            .map(t => t.trim())
            .filter(Boolean)
        : [],
    };
  });
};

// --- Tag Autocomplete Cell ---

interface TagsCellProps {
  tags: string[];
  onChange: (tags: string[]) => void;
  allTags: string[];
  disabled?: boolean;
}

const TagsCell = ({ tags, onChange, allTags, disabled }: TagsCellProps) => {
  const [inputValue, setInputValue] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number }>({
    top: 0,
    left: 0,
    width: 200,
  });

  const filteredTags = useMemo(() => {
    const lower = inputValue.toLowerCase();
    return allTags.filter(t => !tags.includes(t) && t.toLowerCase().includes(lower));
  }, [allTags, tags, inputValue]);

  // Recalculate position when dropdown opens or on scroll
  useLayoutEffect(() => {
    if (!showDropdown || !anchorRef.current) return;
    const updatePos = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (rect) {
        setDropdownPos({
          top: rect.bottom + window.scrollY,
          left: rect.left + window.scrollX,
          width: Math.max(rect.width, 200),
        });
      }
    };
    updatePos();
    // Update on scroll of any ancestor
    const scrollParents: Element[] = [];
    let el: Element | null = anchorRef.current;
    while (el) {
      if (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth) {
        scrollParents.push(el);
        el.addEventListener('scroll', updatePos);
      }
      el = el.parentElement;
    }
    window.addEventListener('scroll', updatePos);
    window.addEventListener('resize', updatePos);
    return () => {
      scrollParents.forEach(p => p.removeEventListener('scroll', updatePos));
      window.removeEventListener('scroll', updatePos);
      window.removeEventListener('resize', updatePos);
    };
  }, [showDropdown]);

  const addTag = (tag: string) => {
    if (!tags.includes(tag)) {
      onChange([...tags, tag]);
    }
    setInputValue('');
  };

  const removeTag = (tag: string) => {
    onChange(tags.filter(t => t !== tag));
  };

  const showCreate = inputValue.trim() && !allTags.includes(inputValue.trim());
  const hasDropdownContent = filteredTags.length > 0 || showCreate;

  return (
    <Box ref={anchorRef} sx={{ position: 'relative', minWidth: 150 }}>
      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 0.5,
          alignItems: 'center',
          border: '1px solid',
          borderColor: 'neutral.outlinedBorder',
          borderRadius: 'sm',
          p: 0.5,
          minHeight: 32,
          cursor: 'text',
        }}
        onClick={() => inputRef.current?.focus()}
      >
        {tags.map(tag => (
          <Chip
            key={tag}
            size="sm"
            variant="soft"
            sx={{ bgcolor: getTagColor(tag) + '22', color: getTagColor(tag) }}
            endDecorator={!disabled ? <ChipDelete onDelete={() => removeTag(tag)} /> : undefined}
          >
            {tag}
          </Chip>
        ))}
        {!disabled && (
          <input
            ref={inputRef}
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            onFocus={() => setShowDropdown(true)}
            onBlur={() => setTimeout(() => setShowDropdown(false), 200)}
            onKeyDown={e => {
              if (e.key === 'Enter' && inputValue.trim()) {
                e.preventDefault();
                addTag(inputValue.trim());
              }
              if (e.key === 'Backspace' && !inputValue && tags.length > 0) {
                removeTag(tags[tags.length - 1]);
              }
            }}
            placeholder={tags.length === 0 ? 'Add tags...' : ''}
            style={{
              border: 'none',
              outline: 'none',
              background: 'transparent',
              fontSize: '0.75rem',
              minWidth: 60,
              flex: 1,
            }}
          />
        )}
      </Box>
      {showDropdown &&
        hasDropdownContent &&
        createPortal(
          <Sheet
            variant="outlined"
            sx={{
              position: 'absolute',
              zIndex: 1400,
              top: dropdownPos.top,
              left: dropdownPos.left,
              width: dropdownPos.width,
              maxHeight: 250,
              overflow: 'auto',
              borderRadius: 'sm',
              boxShadow: 'lg',
            }}
          >
            {filteredTags.slice(0, 10).map(tag => (
              <Box
                key={tag}
                onMouseDown={e => {
                  e.preventDefault();
                  addTag(tag);
                }}
                sx={{
                  px: 1,
                  py: 0.5,
                  cursor: 'pointer',
                  fontSize: '0.8rem',
                  '&:hover': { bgcolor: 'background.level1' },
                }}
              >
                {tag}
              </Box>
            ))}
            {showCreate && (
              <Box
                onMouseDown={e => {
                  e.preventDefault();
                  addTag(inputValue.trim());
                }}
                sx={{
                  px: 1,
                  py: 0.5,
                  cursor: 'pointer',
                  fontSize: '0.8rem',
                  fontStyle: 'italic',
                  '&:hover': { bgcolor: 'background.level1' },
                }}
              >
                Create &quot;{inputValue.trim()}&quot;
              </Box>
            )}
          </Sheet>,
          document.body
        )}
    </Box>
  );
};

// --- Selection Toolbar ---

interface BulkSelectionToolbarProps {
  selectedCount: number;
  allTags: string[];
  onApplyTags: (tags: string[]) => void;
  onSetCredits: (credits: string) => void;
  onSendSelected: () => void;
  onDeleteSelected: () => void;
  sending: boolean;
}

const BulkSelectionToolbar = ({
  selectedCount,
  allTags,
  onApplyTags,
  onSetCredits,
  onSendSelected,
  onDeleteSelected,
  sending,
}: BulkSelectionToolbarProps) => {
  const [showTagPicker, setShowTagPicker] = useState(false);
  const [bulkTags, setBulkTags] = useState<string[]>([]);

  return (
    <Box
      sx={{
        p: 1.5,
        borderRadius: 'sm',
        border: '1px solid',
        borderColor: 'primary.outlinedBorder',
        bgcolor: 'primary.50',
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        flexWrap: 'wrap',
      }}
    >
      <Typography level="body-sm" sx={{ fontWeight: 600 }}>
        {selectedCount} selected
      </Typography>

      <Box sx={{ position: 'relative' }}>
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          startDecorator={<LocalOfferIcon />}
          onClick={() => setShowTagPicker(!showTagPicker)}
        >
          Apply Tags
        </Button>
        {showTagPicker && (
          <Box
            sx={{
              position: 'absolute',
              top: '100%',
              left: 0,
              zIndex: 20,
              mt: 0.5,
              minWidth: 220,
            }}
          >
            <Sheet variant="outlined" sx={{ p: 1, borderRadius: 'sm', boxShadow: 'lg' }}>
              <TagsCell tags={bulkTags} onChange={setBulkTags} allTags={allTags} />
              <Button
                size="sm"
                sx={{ mt: 1, width: '100%' }}
                disabled={bulkTags.length === 0}
                onClick={() => {
                  onApplyTags(bulkTags);
                  setBulkTags([]);
                  setShowTagPicker(false);
                }}
              >
                Apply to {selectedCount} rows
              </Button>
            </Sheet>
          </Box>
        )}
      </Box>

      <Button
        size="sm"
        variant="solid"
        color="primary"
        startDecorator={<SendIcon />}
        onClick={onSendSelected}
        loading={sending}
      >
        Send Selected
      </Button>

      <Button size="sm" variant="outlined" color="danger" startDecorator={<DeleteIcon />} onClick={onDeleteSelected}>
        Delete
      </Button>
    </Box>
  );
};

// --- CSV Paste Panel ---

interface CsvPastePanelProps {
  open: boolean;
  onClose: () => void;
  onAddRows: (rows: Omit<DraftRow, 'id' | 'status'>[]) => void;
}

const CsvPastePanel = ({ open, onClose, onAddRows }: CsvPastePanelProps) => {
  const [csvText, setCsvText] = useState('');
  const parsed = useMemo(() => (csvText ? parseCsvText(csvText) : []), [csvText]);

  if (!open) return null;

  return (
    <Box
      sx={{
        p: 2,
        borderRadius: 'sm',
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.level1',
        mb: 2,
      }}
    >
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
        <Typography level="title-sm">Paste CSV Data</Typography>
        <Button size="sm" variant="plain" onClick={onClose}>
          Close
        </Button>
      </Stack>
      <Typography level="body-xs" sx={{ mb: 1, color: 'text.secondary' }}>
        Format: email, firstName, lastName, credits, storage, tags (semicolon-separated)
      </Typography>
      <Textarea
        minRows={4}
        maxRows={8}
        placeholder="alex@example.com, Alex, Rivera, 100, 5000, Developer;Analyst&#10;jane@co.com, Jane, Smith"
        value={csvText}
        onChange={e => setCsvText(e.target.value)}
        sx={{ mb: 1, fontFamily: 'monospace', fontSize: '0.8rem' }}
      />
      {parsed.length > 0 && (
        <Typography level="body-xs" sx={{ mb: 1 }}>
          Detected {parsed.length} row{parsed.length !== 1 ? 's' : ''}
        </Typography>
      )}
      <Button
        size="sm"
        disabled={parsed.length === 0}
        onClick={() => {
          onAddRows(parsed);
          setCsvText('');
          onClose();
        }}
      >
        Add {parsed.length} to Draft Table
      </Button>
    </Box>
  );
};

// --- Success State ---

interface BulkInviteSuccessProps {
  results: ImportResult[];
  onReset: () => void;
}

const BulkInviteSuccess = ({ results, onReset }: BulkInviteSuccessProps) => {
  const succeeded = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  const summaryText = results
    .filter(r => r.success)
    .map(r => `  - ${r.email}`)
    .join('\n');

  return (
    <Box sx={{ textAlign: 'center', py: 4, px: 2 }}>
      <CheckCircleIcon sx={{ fontSize: 48, color: 'success.500', mb: 1 }} />
      <Typography level="h4" sx={{ mb: 0.5 }}>
        {succeeded} invite{succeeded !== 1 ? 's' : ''} sent successfully
      </Typography>
      {failed > 0 && (
        <Typography level="body-sm" color="danger" sx={{ mb: 2 }}>
          {failed} failed
        </Typography>
      )}
      <Stack direction="row" spacing={1} justifyContent="center" sx={{ mt: 2 }}>
        <CopyButton
          text={`${APP_NAME ? `${APP_NAME} ` : ''}Invite Summary\n========================\n${succeeded} accounts created\n${summaryText}`}
          label="Copy invite summary"
        />
        <Button variant="outlined" onClick={onReset}>
          Invite more people
        </Button>
      </Stack>

      {failed > 0 && (
        <Box sx={{ mt: 3, textAlign: 'left', maxWidth: 500, mx: 'auto' }}>
          <Typography level="title-sm" sx={{ mb: 1 }}>
            Failed:
          </Typography>
          {results
            .filter(r => !r.success)
            .map((r, i) => (
              <Alert key={i} color="danger" variant="soft" size="sm" sx={{ mb: 0.5 }}>
                {r.email}: {r.error}
              </Alert>
            ))}
        </Box>
      )}
    </Box>
  );
};

// --- Main BulkInviteTab ---

interface BulkInviteTabProps {
  quickAction: string | null;
}

const BulkInviteTab = ({ quickAction }: BulkInviteTabProps) => {
  const [rows, setRows] = useState<DraftRow[]>([createEmptyRow()]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [showCsvPanel, setShowCsvPanel] = useState(false);
  const [results, setResults] = useState<ImportResult[] | null>(null);
  const [sendProgress, setSendProgress] = useState<{ completed: number; total: number } | null>(null);
  const emailInputRefs = useRef<Map<string, HTMLInputElement>>(new Map());

  const allTags = useMemo(() => [...PREDEFINED_USER_TAGS], []);

  // Quick action handling
  useEffect(() => {
    if (quickAction === 'quick-invite') {
      const newRow = createEmptyRow();
      setRows(prev => [newRow, ...prev]);
      // Focus the new row's email field after render
      setTimeout(() => {
        const input = emailInputRefs.current.get(newRow.id);
        input?.focus();
      }, 50);
    } else if (quickAction === 'paste-csv') {
      setShowCsvPanel(true);
    }
  }, [quickAction]);

  // Ensure last row is always empty
  useEffect(() => {
    const lastRow = rows[rows.length - 1];
    if (lastRow && (lastRow.email || lastRow.first || lastRow.last)) {
      setRows(prev => [...prev, createEmptyRow()]);
    }
  }, [rows]);

  const updateRow = useCallback((id: string, field: keyof DraftRow, value: string | string[]) => {
    setRows(prev => prev.map(r => (r.id === id ? { ...r, [field]: value } : r)));
  }, []);

  const deleteRows = useCallback((ids: Set<string>) => {
    setRows(prev => {
      const filtered = prev.filter(r => !ids.has(r.id));
      return filtered.length === 0 ? [createEmptyRow()] : filtered;
    });
    setSelectedIds(new Set());
  }, []);

  const addCsvRows = useCallback((parsed: Omit<DraftRow, 'id' | 'status'>[]) => {
    const newRows: DraftRow[] = parsed.map(p => ({
      ...p,
      id: crypto.randomUUID(),
      status: 'draft' as const,
    }));
    setRows(prev => {
      // Insert before the trailing empty row
      const withoutTrailing = prev.filter(r => r.email || r.first || r.last);
      return [...withoutTrailing, ...newRows, createEmptyRow()];
    });
    toast.success(`Added ${newRows.length} row${newRows.length !== 1 ? 's' : ''} from CSV`);
  }, []);

  // Multi-line paste detection on email field
  const handleEmailPaste = useCallback(
    (rowId: string, e: React.ClipboardEvent) => {
      const text = e.clipboardData.getData('text');
      if (text.includes('\n') || text.includes('\t')) {
        e.preventDefault();
        const parsed = parseCsvText(text);
        if (parsed.length > 1) {
          addCsvRows(parsed);
        } else if (parsed.length === 1) {
          updateRow(rowId, 'email', parsed[0].email);
          if (parsed[0].first) updateRow(rowId, 'first', parsed[0].first);
          if (parsed[0].last) updateRow(rowId, 'last', parsed[0].last);
          if (parsed[0].credits) updateRow(rowId, 'credits', parsed[0].credits);
          if (parsed[0].storage) updateRow(rowId, 'storage', parsed[0].storage);
          if (parsed[0].tags.length > 0) updateRow(rowId, 'tags', parsed[0].tags);
        }
      }
    },
    [addCsvRows, updateRow]
  );

  const applyTagsToSelected = useCallback(
    (tags: string[]) => {
      setRows(prev =>
        prev.map(r => {
          if (!selectedIds.has(r.id)) return r;
          const merged = Array.from(new Set([...r.tags, ...tags]));
          return { ...r, tags: merged };
        })
      );
      toast.success(`Applied tags to ${selectedIds.size} row${selectedIds.size !== 1 ? 's' : ''}`);
    },
    [selectedIds]
  );

  const draftRows = useMemo(() => rows.filter(r => r.email && r.status === 'draft'), [rows]);

  const sendInvites = useCallback(
    async (rowIds?: Set<string>) => {
      const toSend = draftRows.filter(r => {
        if (rowIds && !rowIds.has(r.id)) return false;
        return !validateRow(r, rows);
      });

      if (toSend.length === 0) {
        toast.error('No valid rows to send');
        return;
      }

      setSending(true);
      setSendProgress({ completed: 0, total: toSend.length });

      const users = toSend.map(r => ({
        email: r.email,
        first: r.first || undefined,
        last: r.last || undefined,
        startingCredits: Math.max(0, r.credits ? parseInt(r.credits) || 0 : 0),
        startingStorage: Math.max(0, r.storage ? parseInt(r.storage) || 0 : 0),
        tags: r.tags.length > 0 ? r.tags : undefined,
      }));

      try {
        const response = await api.post<{ success: boolean; results: ImportResult[] }>('/api/admin/bulk-create-users', {
          users,
        });

        const apiResults = response.data.results;
        setResults(apiResults);

        // Update row statuses
        setRows(prev =>
          prev.map(r => {
            const idx = toSend.findIndex(s => s.id === r.id);
            if (idx === -1) return r;
            const result = apiResults[idx];
            return {
              ...r,
              status: result?.success ? ('sent' as const) : ('failed' as const),
              error: result?.error,
            };
          })
        );

        const succeeded = apiResults.filter(r => r.success).length;
        const failed = apiResults.filter(r => !r.success).length;
        if (failed === 0) {
          toast.success(`${succeeded} invite${succeeded !== 1 ? 's' : ''} sent!`);
        } else {
          toast.warning(`${succeeded} sent, ${failed} failed`);
        }
      } catch (err) {
        toast.error('Failed to send invites');
        console.error(err);
      } finally {
        setSending(false);
        setSendProgress(null);
        setSelectedIds(new Set());
      }
    },
    [draftRows, rows]
  );

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    const nonEmptyRows = rows.filter(r => r.email);
    if (selectedIds.size === nonEmptyRows.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(nonEmptyRows.map(r => r.id)));
    }
  }, [rows, selectedIds]);

  const handleReset = useCallback(() => {
    setRows([createEmptyRow()]);
    setSelectedIds(new Set());
    setResults(null);
  }, []);

  // Show success state
  if (results && results.every(r => r.success)) {
    return (
      <Box sx={{ px: 3 }}>
        <BulkInviteSuccess results={results} onReset={handleReset} />
      </Box>
    );
  }

  const nonEmptyRows = rows.filter(r => r.email);
  const hasValidRows = draftRows.some(r => !validateRow(r, rows));
  const allSelected = nonEmptyRows.length > 0 && selectedIds.size === nonEmptyRows.length;

  return (
    <Box sx={{ px: 3, py: 1 }}>
      <CsvPastePanel open={showCsvPanel} onClose={() => setShowCsvPanel(false)} onAddRows={addCsvRows} />

      {selectedIds.size > 0 && (
        <Box sx={{ mb: 1 }}>
          <BulkSelectionToolbar
            selectedCount={selectedIds.size}
            allTags={allTags}
            onApplyTags={applyTagsToSelected}
            onSetCredits={() => {}}
            onSendSelected={() => sendInvites(selectedIds)}
            onDeleteSelected={() => deleteRows(selectedIds)}
            sending={sending}
          />
        </Box>
      )}

      {/* Table */}
      <Box sx={{ overflowX: 'auto' }}>
        <Box sx={{ minWidth: 800 }}>
          {/* Header */}
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: '40px 1fr 0.7fr 0.7fr 80px 80px 1.2fr 80px 40px',
              gap: 1,
              px: 1,
              py: 0.5,
              borderBottom: '2px solid',
              borderColor: 'divider',
              alignItems: 'center',
            }}
          >
            <Checkbox
              size="sm"
              checked={allSelected}
              indeterminate={selectedIds.size > 0 && !allSelected}
              onChange={toggleSelectAll}
            />
            <Typography level="body-xs" sx={{ fontWeight: 700 }}>
              Email
            </Typography>
            <Typography level="body-xs" sx={{ fontWeight: 700 }}>
              First
            </Typography>
            <Typography level="body-xs" sx={{ fontWeight: 700 }}>
              Last
            </Typography>
            <Typography level="body-xs" sx={{ fontWeight: 700 }}>
              Credits
            </Typography>
            <Typography level="body-xs" sx={{ fontWeight: 700 }}>
              Storage
            </Typography>
            <Typography level="body-xs" sx={{ fontWeight: 700 }}>
              Tags
            </Typography>
            <Typography level="body-xs" sx={{ fontWeight: 700 }}>
              Status
            </Typography>
            <Box />
          </Box>

          {/* Rows */}
          {rows.map(row => {
            const error = row.email ? validateRow(row, rows) : undefined;
            const isSent = row.status === 'sent';
            const isFailed = row.status === 'failed';
            const isEmpty = !row.email && !row.first && !row.last;

            return (
              <Box
                key={row.id}
                sx={{
                  display: 'grid',
                  gridTemplateColumns: '40px 1fr 0.7fr 0.7fr 80px 80px 1.2fr 80px 40px',
                  gap: 1,
                  px: 1,
                  py: 0.5,
                  borderBottom: '1px solid',
                  borderColor: 'divider',
                  alignItems: 'center',
                  opacity: isSent ? 0.6 : 1,
                  bgcolor: isFailed ? 'danger.50' : isSent ? 'success.50' : 'transparent',
                  '&:hover': { bgcolor: isSent ? 'success.50' : isFailed ? 'danger.50' : 'background.level1' },
                }}
                data-testid={`bulk-invite-row-${row.id}`}
              >
                <Checkbox
                  size="sm"
                  checked={selectedIds.has(row.id)}
                  onChange={() => toggleSelect(row.id)}
                  disabled={isEmpty}
                />
                <Input
                  size="sm"
                  variant="plain"
                  placeholder="email@example.com"
                  value={row.email}
                  onChange={e => updateRow(row.id, 'email', e.target.value)}
                  onPaste={e => handleEmailPaste(row.id, e)}
                  disabled={isSent}
                  color={error ? 'danger' : undefined}
                  slotProps={{
                    input: {
                      ref: (el: HTMLInputElement | null) => {
                        if (el) emailInputRefs.current.set(row.id, el);
                        else emailInputRefs.current.delete(row.id);
                      },
                    },
                  }}
                  sx={{ fontSize: '0.8rem' }}
                />
                <Input
                  size="sm"
                  variant="plain"
                  placeholder="First"
                  value={row.first}
                  onChange={e => updateRow(row.id, 'first', e.target.value)}
                  disabled={isSent}
                  sx={{ fontSize: '0.8rem' }}
                />
                <Input
                  size="sm"
                  variant="plain"
                  placeholder="Last"
                  value={row.last}
                  onChange={e => updateRow(row.id, 'last', e.target.value)}
                  disabled={isSent}
                  sx={{ fontSize: '0.8rem' }}
                />
                <Input
                  size="sm"
                  variant="plain"
                  placeholder="0"
                  value={row.credits}
                  onChange={e => updateRow(row.id, 'credits', e.target.value)}
                  disabled={isSent}
                  slotProps={{ input: { type: 'number', min: 0, step: 1 } }}
                  sx={{ fontSize: '0.8rem' }}
                />
                <Input
                  size="sm"
                  variant="plain"
                  placeholder="1000"
                  value={row.storage}
                  onChange={e => updateRow(row.id, 'storage', e.target.value)}
                  disabled={isSent}
                  slotProps={{ input: { type: 'number', min: 0, step: 1 } }}
                  sx={{ fontSize: '0.8rem' }}
                />
                <TagsCell
                  tags={row.tags}
                  onChange={tags => updateRow(row.id, 'tags', tags)}
                  allTags={allTags}
                  disabled={isSent}
                />
                <Box>
                  {isSent && (
                    <Chip size="sm" color="success" variant="soft">
                      Sent
                    </Chip>
                  )}
                  {isFailed && (
                    <Tooltip title={row.error || 'Failed'}>
                      <Chip
                        size="sm"
                        color="danger"
                        variant="soft"
                        startDecorator={<ErrorIcon sx={{ fontSize: 14 }} />}
                      >
                        Failed
                      </Chip>
                    </Tooltip>
                  )}
                  {row.status === 'draft' && row.email && (
                    <Chip size="sm" color="neutral" variant="soft">
                      Draft
                    </Chip>
                  )}
                </Box>
                <Box>
                  {!isSent && row.email && (
                    <IconButton size="sm" variant="plain" color="danger" onClick={() => deleteRows(new Set([row.id]))}>
                      <DeleteIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  )}
                </Box>
              </Box>
            );
          })}
        </Box>
      </Box>

      {/* Send All button */}
      {draftRows.length > 0 && (
        <Stack direction="row" spacing={1} sx={{ mt: 2 }} justifyContent="flex-end">
          {sendProgress && (
            <Typography level="body-sm" sx={{ alignSelf: 'center' }}>
              {sendProgress.completed} of {sendProgress.total} sent...
            </Typography>
          )}
          <Button
            startDecorator={<SendIcon />}
            onClick={() => sendInvites()}
            loading={sending}
            disabled={!hasValidRows}
            data-testid="bulk-invite-send-all-btn"
          >
            Send {draftRows.length} Invite{draftRows.length !== 1 ? 's' : ''}
          </Button>
        </Stack>
      )}

      {/* Show partial results with failures */}
      {results && !results.every(r => r.success) && (
        <Box sx={{ mt: 2 }}>
          <BulkInviteSuccess results={results} onReset={handleReset} />
        </Box>
      )}
    </Box>
  );
};

export default BulkInviteTab;
