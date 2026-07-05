import React, { useState, useEffect, useCallback } from 'react';
import { Box, Typography, FormControl, FormLabel, Radio, RadioGroup, Stack, Input, Button, Divider } from '@mui/joy';
import Bike4MindIcon from '../svgs/icons/Bike4MindIcon';
import { CREDIT_SOURCE } from '../../constants/agentForm';
import { api } from '../../contexts/ApiContext';
import { toast } from 'sonner';
import { green } from '@client/app/utils/themes/colors';

interface AgentCreditManagementProps {
  useOwnCredits: boolean;
  currentCredits: number;
  userCredits: number;
  agentId?: string;
  readOnly?: boolean;
  onCreditSourceChange?: (value: string) => void;
  onTransferCredits?: (amount: number) => void; // Legacy prop, will be used if provided
  isTransferring?: boolean;
  onCurrentCreditsChange?: (value: number) => void;
  onTransferComplete?: () => void;
  onCreditsUpdate?: (agentCredits: number, userCredits: number) => void;
  // For custom user state management
  setCurrentUser?: (user: any) => void;
  currentUser?: any;
  showInfoText?: boolean;
  sx?: any;
}

const AgentCreditManagement: React.FC<AgentCreditManagementProps> = ({
  useOwnCredits,
  currentCredits,
  userCredits,
  agentId,
  readOnly = true,
  onCreditSourceChange,
  onTransferCredits,
  isTransferring: externalIsTransferring,
  onCurrentCreditsChange,
  onTransferComplete,
  onCreditsUpdate,
  setCurrentUser,
  currentUser,
  showInfoText = false,
  sx,
}) => {
  const [transferAmount, setTransferAmount] = useState(0);
  const [previousIsTransferring, setPreviousIsTransferring] = useState(false);
  const [internalIsTransferring, setInternalIsTransferring] = useState(false);
  const [isUpdatingCreditSource, setIsUpdatingCreditSource] = useState(false);

  // Store the initial credits value to prevent it from changing when typing in the input
  const [displayedCredits, setDisplayedCredits] = useState(currentCredits);

  // Use external isTransferring if provided, otherwise use internal state
  const isTransferring = externalIsTransferring !== undefined ? externalIsTransferring : internalIsTransferring;

  // Update displayed credits only when the prop actually changes
  useEffect(() => {
    if (!agentId && !onTransferCredits) {
      // In create mode, always show 0 as current agent credits (agent doesn't exist yet)
      setDisplayedCredits(0);
    } else {
      // In edit mode, show the actual current credits
      setDisplayedCredits(currentCredits);
    }
  }, [agentId, onTransferCredits, currentCredits]);

  // Reset transfer amount when transfer completes
  useEffect(() => {
    if (previousIsTransferring && !isTransferring) {
      setTransferAmount(0);
      onTransferComplete?.();
    }
    setPreviousIsTransferring(isTransferring);
  }, [isTransferring, previousIsTransferring, onTransferComplete]);

  // Reset transfer amount when switching to USER credits (but don't reset agent credits)
  useEffect(() => {
    if (!useOwnCredits && !onTransferCredits) {
      // When USER is selected, only clear transferAmount (agent credits stay as they are)
      setTransferAmount(0);
    }
  }, [useOwnCredits, onTransferCredits]);

  const handleCreditSourceChange = async (value: string) => {
    // Prevent double calls
    if (isUpdatingCreditSource) {
      return;
    }

    const newUseOwnCredits = value === CREDIT_SOURCE.AGENT;

    setIsUpdatingCreditSource(true);

    try {
      // Call the parent callback if provided
      if (onCreditSourceChange) {
        await onCreditSourceChange(value);
      }

      // Also handle server update if agentId is provided (edit mode)
      if (agentId) {
        await api.put(`/api/agents/${agentId}`, {
          useOwnCredits: newUseOwnCredits,
        });

        toast.success(`Agent credit source updated to ${newUseOwnCredits ? "agent's own credits" : "user's credits"}`, {
          duration: 2500,
        });
      }
    } catch (error: any) {
      console.error('Error updating agent credit source:', error);
      toast.error(error.response?.data?.message || 'Failed to update agent credit source');
    } finally {
      setIsUpdatingCreditSource(false);
    }
  };

  // Internal transfer credits handler
  const handleTransferCredits = useCallback(
    async (amount: number) => {
      if (!agentId || amount <= 0) {
        toast.error('Please enter a valid amount to transfer');
        return;
      }

      // Get actual user credits from context if available
      const actualUserCredits = currentUser?.currentCredits ?? userCredits;

      if (actualUserCredits < amount) {
        toast.error(`You don't have enough credits. Your current balance: ${actualUserCredits.toLocaleString()}`);
        return;
      }

      setInternalIsTransferring(true);
      try {
        const response = await api.post(`/api/agents/${agentId}/transfer-credits`, {
          amount: amount,
        });
        toast.success(`Successfully transferred ${amount.toLocaleString()} credits to agent`);

        // Call the unified update callback
        if (onCreditsUpdate) {
          onCreditsUpdate(response.data.agentCredits, response.data.userCredits);
        }

        // Also update user credits if setCurrentUser is provided
        if (currentUser && setCurrentUser) {
          setCurrentUser({
            ...currentUser,
            currentCredits: response.data.userCredits,
          });
        }

        onTransferComplete?.();
      } catch (error: any) {
        toast.error(error.response?.data?.message || 'Failed to transfer credits');
      } finally {
        setInternalIsTransferring(false);
      }
    },
    [agentId, userCredits, onCreditsUpdate, currentUser, setCurrentUser, onTransferComplete]
  );

  const handleInternalTransfer = () => {
    // Don't allow transfer if already in progress
    if (isTransferring) {
      return;
    }

    if (transferAmount > 0 && agentId && !onTransferCredits) {
      handleTransferCredits(transferAmount);
    } else if (onTransferCredits && transferAmount > 0) {
      onTransferCredits(transferAmount);
    }
  };

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        border: '1px solid',
        borderColor: 'border.input',
        borderRadius: '8px',
        backgroundColor: 'background.panel',
        p: 2,
        height: '100%',
        ...sx,
      }}
    >
      <RadioGroup
        value={useOwnCredits ? CREDIT_SOURCE.AGENT : CREDIT_SOURCE.USER}
        sx={{
          opacity: isUpdatingCreditSource ? 0.6 : 1,
          pointerEvents: isUpdatingCreditSource ? 'none' : 'auto',
          transition: 'opacity 0.2s ease-in-out',
        }}
      >
        {/* First Option - Use User Account Credits */}
        <FormControl
          size="sm"
          onClick={readOnly || !useOwnCredits ? undefined : () => handleCreditSourceChange(CREDIT_SOURCE.USER)}
          sx={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            border: 'none',
            p: 0,
            mb: 1.5,
            gap: '12px',
            cursor: readOnly ? 'default' : 'pointer',
            transition: 'all 0.2s ease-in-out',
          }}
        >
          <Radio value={CREDIT_SOURCE.USER} disabled={readOnly || isUpdatingCreditSource} />
          <Box
            sx={{
              display: 'flex',
              flexDirection: { xs: 'column', sm: 'row' },
              gap: { xs: '4px', sm: '12px' },
              flexGrow: 1,
              pointerEvents: readOnly ? 'none' : 'auto',
            }}
          >
            <FormLabel
              sx={{ cursor: readOnly ? 'default' : 'pointer', mb: 0, color: 'text.tertiary', fontSize: '14px' }}
            >
              Your account credits balance:
            </FormLabel>
            <Stack
              direction="row"
              sx={{ position: 'relative', m: 0 }}
              spacing={0}
              alignItems="center"
              alignSelf="flex-start"
            >
              {useOwnCredits && transferAmount > 0 && (
                <Stack
                  direction="row"
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    position: 'absolute',
                    gap: '2px',
                    left: 'calc(100% + 1px)',
                    whiteSpace: 'nowrap',
                    top: '-5px',
                  }}
                  alignItems="center"
                >
                  <Typography
                    sx={{
                      color: 'danger.500',
                      fontWeight: 600,
                      fontSize: '8px',
                    }}
                  >
                    -{transferAmount.toLocaleString()}
                  </Typography>
                  <Typography sx={{ fontWeight: 600, color: 'text.tertiary', fontSize: '8px' }}>
                    = {Math.max(0, userCredits - transferAmount).toLocaleString()}
                  </Typography>
                </Stack>
              )}

              <Typography level="body-sm" sx={{ display: 'flex', color: 'text.primary', alignItems: 'center', gap: 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0, flex: 'none' }}>
                  <Bike4MindIcon size="12" fill="var(--joy-palette-text-tertiary)" />
                </Box>
                {userCredits.toLocaleString()}
              </Typography>
            </Stack>
          </Box>
        </FormControl>

        {/* Second Option - Use Agent's Own Credits */}
        <FormControl
          size="sm"
          onClick={readOnly || useOwnCredits ? undefined : () => handleCreditSourceChange(CREDIT_SOURCE.AGENT)}
          sx={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            border: 'none',
            p: 0,
            gap: '12px',
            cursor: readOnly ? 'default' : 'pointer',
            transition: 'all 0.2s ease-in-out',
          }}
        >
          <Radio value={CREDIT_SOURCE.AGENT} disabled={readOnly || isUpdatingCreditSource} />
          <Box
            sx={{
              display: 'flex',
              flexDirection: { xs: 'column', sm: 'row' },
              gap: { xs: '4px', sm: '12px' },
              flexGrow: 1,
              pointerEvents: readOnly ? 'none' : 'auto',
            }}
          >
            <FormLabel
              sx={{ cursor: readOnly ? 'default' : 'pointer', mb: 0, color: 'text.tertiary', fontSize: '14px' }}
            >
              Agent&apos;s own credits balance:
            </FormLabel>
            <Stack
              direction="row"
              spacing={0}
              m={0}
              alignItems="center"
              sx={{ position: 'relative', alignSelf: 'flex-start' }}
            >
              {useOwnCredits && transferAmount > 0 && (
                <Stack
                  direction="row"
                  justifyContent="space-between"
                  alignItems="center"
                  sx={{
                    position: 'absolute',
                    left: 'calc(100% + 1px)',
                    whiteSpace: 'nowrap',
                    top: '-5px',
                    gap: '2px',
                    m: 0,
                  }}
                >
                  <Stack direction="row" sx={{ m: 0, gap: '2px' }} spacing={0} alignItems="center">
                    <Typography
                      level="body-sm"
                      sx={{
                        color: green[800],
                        fontWeight: 600,
                        fontSize: '8px',
                      }}
                    >
                      +{transferAmount.toLocaleString()}
                    </Typography>
                    <Typography level="body-sm" sx={{ fontWeight: 600, color: 'text.tertiary', fontSize: '8px' }}>
                      = {(displayedCredits + transferAmount).toLocaleString()}
                    </Typography>
                  </Stack>
                </Stack>
              )}

              <Typography level="body-sm" sx={{ display: 'flex', color: 'text.primary', alignItems: 'center', gap: 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0, flex: 'none' }}>
                  <Bike4MindIcon size="12" fill="var(--joy-palette-text-tertiary)" />
                </Box>
                {displayedCredits.toLocaleString()}
              </Typography>
            </Stack>
          </Box>
        </FormControl>
      </RadioGroup>

      {/* {isUpdatingCreditSource && (
        <Typography level="body-sm" sx={{ mt: 1, color: 'text.primary50', textAlign: 'left', fontSize: '10px' }}>
          Updating credit source...
        </Typography>
      )} */}

      {useOwnCredits && (
        <>
          {/* Transfer Amount Input */}
          <Box sx={{ mt: 2 }}>
            <FormControl size="sm" sx={{ flexGrow: 1, width: '100%', position: 'relative' }}>
              <Input
                size="sm"
                type="number"
                value={transferAmount || ''}
                placeholder="Enter amount to transfer"
                startDecorator={<Bike4MindIcon size="12" fill="var(--joy-palette-text-tertiary)" />}
                sx={{
                  border: '1px solid',
                  borderColor: 'border.input',
                  backgroundColor: 'background.panel',
                  color: 'text.primary',
                  boxShadow: 'none',
                  '& input[type="number"]::-webkit-outer-spin-button': {
                    '-webkit-appearance': 'none',
                    margin: 0,
                  },
                  '& input[type="number"]::-webkit-inner-spin-button': {
                    '-webkit-appearance': 'none',
                    margin: 0,
                  },
                  '& input[type="number"]': {
                    '-moz-appearance': 'textfield',
                  },
                }}
                onKeyDown={e => {
                  // Prevent minus sign, plus sign, and 'e' (scientific notation)
                  if (e.key === '-' || e.key === '+' || e.key === 'e' || e.key === 'E') {
                    e.preventDefault();
                  }
                }}
                onChange={e => {
                  const value = parseFloat(e.target.value) || 0;
                  const safeValue = Math.min(value, userCredits);
                  setTransferAmount(safeValue);

                  // In create mode, save the amount to form state
                  // This value will be used when creating the agent
                  if (!agentId && !onTransferCredits && onCurrentCreditsChange) {
                    onCurrentCreditsChange(safeValue);
                  }
                }}
                slotProps={{
                  input: {
                    min: 0,
                    max: userCredits,
                    step: 100,
                    inputMode: 'numeric',
                  },
                }}
                readOnly={readOnly}
              />

              {(agentId || onTransferCredits) && (
                <Button
                  variant="solid"
                  color="primary"
                  size="sm"
                  disabled={transferAmount <= 0 || isTransferring || readOnly}
                  loading={isTransferring}
                  onClick={readOnly ? undefined : handleInternalTransfer}
                  sx={{
                    position: 'absolute',
                    bottom: 0,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    right: '4px',
                    flex: 'none',
                    height: '24px',
                    minHeight: '24px',
                    borderRadius: '6px',
                    fontWeight: 600,
                  }}
                >
                  Transfer
                </Button>
              )}
            </FormControl>
            {!agentId && !onTransferCredits && (
              <Typography level="body-sm" sx={{ mt: 1, color: 'primary.solidBg', textAlign: 'left', fontSize: '10px' }}>
                Credits will be set when the agent is created
              </Typography>
            )}

            {useOwnCredits && (
              <Typography
                level="body-sm"
                sx={{ mt: 0.5, color: 'text.primary50', textAlign: 'left', fontSize: '10px' }}
              >
                Once transferred, credits cannot be returned. You can only transfer credits to an agent, not from one.
              </Typography>
            )}
          </Box>
        </>
      )}

      {showInfoText && (
        <Box sx={{ mt: 'auto', pt: 2 }}>
          <Divider sx={{ my: 1, '--Divider-lineColor': 'var(--joy-palette-border-input)', mb: 2 }} />
          <Typography sx={{ fontSize: '12px', fontWeight: 500, color: 'primary.solidBg' }}>
            {useOwnCredits
              ? 'This agent will use its own credits for all operations instead of deducting from your account.'
              : "Currently using YOUR credits for this agent's operations. Switch to \"Agent's own credits balance\" above to use the agent's credits instead."}
          </Typography>
        </Box>
      )}
    </Box>
  );
};

export default AgentCreditManagement;
