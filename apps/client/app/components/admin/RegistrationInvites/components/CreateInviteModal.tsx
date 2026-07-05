import React, { FormEvent, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  ChipDelete,
  FormControl,
  FormHelperText,
  FormLabel,
  Grid,
  Input,
  Modal,
  ModalClose,
  Sheet,
  Typography,
} from '@mui/joy';
import { createPortal } from 'react-dom';
import { PREDEFINED_USER_TAGS } from '@bike4mind/common';
import { useGetUserTags } from '@client/app/hooks/data/user';
import { getTagColor } from '../../InviteCenter/shared/tagColors';
import { useRegistrationInvitesStore } from '../store';
import { CreateInviteFormData } from '../types';

interface CreateInviteModalProps {
  onSubmit: (data: CreateInviteFormData) => void;
  isLoading: boolean;
}

export const CreateInviteModal: React.FC<CreateInviteModalProps> = ({ onSubmit, isLoading }) => {
  const { openCreate, setOpenCreate, errors, updateError, clearErrors } = useRegistrationInvitesStore();
  const [unlimitedUse, setUnlimitedUse] = useState(false);
  const [spicyConfirm, setSpicyConfirm] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [startingCredits, setStartingCredits] = useState<string>('25000');
  const [startingStorage, setStartingStorage] = useState<string>('1000');

  // Tag picker state
  const [tagInput, setTagInput] = useState('');
  const [showTagDropdown, setShowTagDropdown] = useState(false);
  const tagInputRef = useRef<HTMLInputElement>(null);
  const tagAnchorRef = useRef<HTMLDivElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number }>({
    top: 0,
    left: 0,
    width: 200,
  });

  const userTagsQuery = useGetUserTags();
  const allTags = useMemo(() => {
    const apiTags = userTagsQuery.data || [];
    return Array.from(new Set([...PREDEFINED_USER_TAGS, ...apiTags]));
  }, [userTagsQuery.data]);

  const filteredTags = useMemo(() => {
    const lower = tagInput.toLowerCase();
    return allTags.filter(t => !tags.includes(t) && t.toLowerCase().includes(lower));
  }, [allTags, tags, tagInput]);

  // Recalculate dropdown position
  useLayoutEffect(() => {
    if (!showTagDropdown || !tagAnchorRef.current) return;
    const updatePos = () => {
      const rect = tagAnchorRef.current?.getBoundingClientRect();
      if (rect) {
        setDropdownPos({
          top: rect.bottom + window.scrollY,
          left: rect.left + window.scrollX,
          width: Math.max(rect.width, 200),
        });
      }
    };
    updatePos();
    const scrollParents: Element[] = [];
    let el: Element | null = tagAnchorRef.current;
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
  }, [showTagDropdown]);

  const addTag = (tag: string) => {
    if (!tags.includes(tag)) {
      setTags(prev => [...prev, tag]);
    }
    setTagInput('');
  };

  const removeTag = (tag: string) => {
    setTags(prev => prev.filter(t => t !== tag));
  };

  const showCreate = tagInput.trim() && !allTags.includes(tagInput.trim());
  const hasDropdownContent = filteredTags.length > 0 || showCreate;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const formData = new FormData(e.target as HTMLFormElement);
    const multiple = Number(formData.get('multiple'));

    clearErrors();

    if (!multiple || multiple < 1) {
      updateError('multiple', 'Please enter a number greater than 0');
      return;
    }

    const parsedCredits = parseInt(startingCredits, 10);
    const parsedStorage = parseInt(startingStorage, 10);

    const payload: CreateInviteFormData = {
      multiple,
      unlimitedUse,
      ...(tags.length > 0 ? { tags } : {}),
      ...(Number.isFinite(parsedCredits) ? { startingCredits: parsedCredits } : {}),
      ...(Number.isFinite(parsedStorage) ? { startingStorage: parsedStorage } : {}),
    };

    onSubmit(payload);
  };

  const handleClose = () => {
    setOpenCreate(false);
    clearErrors();
    setUnlimitedUse(false);
    setSpicyConfirm('');
    setTags([]);
    setStartingCredits('25000');
    setStartingStorage('1000');
    setTagInput('');
    setShowTagDropdown(false);
  };

  return (
    <Modal
      open={openCreate}
      onClose={handleClose}
      sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}
    >
      <Sheet
        sx={{
          width: '460px',
          boxShadow: 'lg',
          borderRadius: '8px',
          padding: '0px',
        }}
      >
        <ModalClose />
        <Box textAlign={'center'}>
          <Typography data-testid="create-invite-modal" mt={'30px'} mb={'20px'} component={'h2'} level="h4">
            Create Registration Invites
          </Typography>

          <form onSubmit={handleSubmit}>
            <Box sx={{ display: 'grid', gap: '1em', px: '2em', pb: '1.5em' }}>
              <Grid container spacing={2}>
                <Grid xs={12}>
                  <FormControl required id="multiple">
                    <FormLabel id="multiple-label">Number of Invites to create</FormLabel>
                    <Input
                      fullWidth
                      error={!!errors.multiple}
                      type={'number'}
                      defaultValue={1}
                      variant={'outlined'}
                      name={'multiple'}
                    />
                    <FormHelperText>
                      <Typography level={'body-xs'} color={'danger'}>
                        {errors.multiple}
                      </Typography>
                    </FormHelperText>
                  </FormControl>
                </Grid>

                <Grid xs={12}>
                  <FormControl>
                    <FormLabel>Allow unlimited use</FormLabel>
                    <Typography level="body-xs" sx={{ opacity: 0.7, mb: 0.5, textAlign: 'left' }}>
                      Keeps the invite reusable even after the first signup. Type &quot;spicy&quot; to enable.
                    </Typography>
                    <Input
                      placeholder='Type "spicy" to enable unlimited use'
                      value={spicyConfirm}
                      onChange={e => {
                        setSpicyConfirm(e.target.value);
                        setUnlimitedUse(e.target.value.toLowerCase().trim() === 'spicy');
                      }}
                      color={unlimitedUse ? 'danger' : 'neutral'}
                    />
                    {unlimitedUse && (
                      <Typography level="body-xs" color="danger" sx={{ mt: 0.5 }}>
                        Unlimited use enabled. Invites will automatically expire 90 days after creation.
                      </Typography>
                    )}
                  </FormControl>
                </Grid>

                {/* Tags */}
                <Grid xs={12}>
                  <FormControl>
                    <FormLabel>Tags</FormLabel>
                    <Box ref={tagAnchorRef} sx={{ position: 'relative' }}>
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
                          minHeight: 36,
                          cursor: 'text',
                        }}
                        onClick={() => tagInputRef.current?.focus()}
                      >
                        {tags.map(tag => (
                          <Chip
                            key={tag}
                            size="sm"
                            variant="soft"
                            sx={{ bgcolor: getTagColor(tag) + '22', color: getTagColor(tag) }}
                            endDecorator={<ChipDelete onDelete={() => removeTag(tag)} />}
                          >
                            {tag}
                          </Chip>
                        ))}
                        <input
                          ref={tagInputRef}
                          value={tagInput}
                          onChange={e => setTagInput(e.target.value)}
                          onFocus={() => setShowTagDropdown(true)}
                          onBlur={() => setTimeout(() => setShowTagDropdown(false), 200)}
                          onKeyDown={e => {
                            if (e.key === 'Enter' && tagInput.trim()) {
                              e.preventDefault();
                              addTag(tagInput.trim());
                            }
                            if (e.key === 'Backspace' && !tagInput && tags.length > 0) {
                              removeTag(tags[tags.length - 1]);
                            }
                          }}
                          placeholder={tags.length === 0 ? 'Add tags...' : ''}
                          style={{
                            border: 'none',
                            outline: 'none',
                            background: 'transparent',
                            fontSize: '0.85rem',
                            minWidth: 60,
                            flex: 1,
                          }}
                        />
                      </Box>
                      {showTagDropdown &&
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
                                  fontSize: '0.85rem',
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
                                  addTag(tagInput.trim());
                                }}
                                sx={{
                                  px: 1,
                                  py: 0.5,
                                  cursor: 'pointer',
                                  fontSize: '0.85rem',
                                  fontStyle: 'italic',
                                  '&:hover': { bgcolor: 'background.level1' },
                                }}
                              >
                                Create &quot;{tagInput.trim()}&quot;
                              </Box>
                            )}
                          </Sheet>,
                          document.body
                        )}
                    </Box>
                    <FormHelperText>
                      <Typography level="body-xs" sx={{ opacity: 0.7 }}>
                        Tags assigned to users who redeem these invite codes.
                      </Typography>
                    </FormHelperText>
                  </FormControl>
                </Grid>

                {/* Credits & Storage */}
                <Grid xs={6}>
                  <FormControl>
                    <FormLabel>Starting Credits</FormLabel>
                    <Input
                      type="number"
                      value={startingCredits}
                      onChange={e => setStartingCredits(e.target.value)}
                      slotProps={{ input: { min: 0 } }}
                    />
                    <FormHelperText>
                      <Typography level="body-xs" sx={{ opacity: 0.7 }}>
                        Half of one month&apos;s subscription.
                      </Typography>
                    </FormHelperText>
                  </FormControl>
                </Grid>
                <Grid xs={6}>
                  <FormControl>
                    <FormLabel>Starting Storage (MB)</FormLabel>
                    <Input
                      type="number"
                      value={startingStorage}
                      onChange={e => setStartingStorage(e.target.value)}
                      slotProps={{ input: { min: 0 } }}
                    />
                    <FormHelperText>
                      <Typography level="body-xs" sx={{ opacity: 0.7 }}>
                        Default: 1 GB.
                      </Typography>
                    </FormHelperText>
                  </FormControl>
                </Grid>

                <Grid xs={12}>
                  <Box display={'flex'} justifyContent={'center'}>
                    <Button
                      data-testid="create-invite-submit-btn"
                      loading={isLoading}
                      type="submit"
                      sx={{ width: '50%' }}
                      color={'primary'}
                      variant={'solid'}
                    >
                      Submit
                    </Button>
                  </Box>
                </Grid>
              </Grid>
            </Box>
          </form>
        </Box>
      </Sheet>
    </Modal>
  );
};
