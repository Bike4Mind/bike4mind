import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import Input from '@mui/joy/Input';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { ChatQuestion, ChatQuestionAnswer } from '@shared/questions';
import {
  emptyPicks,
  isAnswered,
  isComplete,
  nextUnanswered,
  toAnswers,
  toggleOption,
  toggleOther,
  typeOther,
  type QuestionPick,
} from './questionCardModel';

function OptionRow({
  testId,
  checked,
  multi,
  index,
  onSelect,
  children,
}: {
  testId: string;
  checked: boolean;
  multi: boolean;
  index: number;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <Box
      role={multi ? 'checkbox' : 'radio'}
      aria-checked={checked}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={event => {
        if (event.key === ' ' && event.target === event.currentTarget) {
          event.preventDefault();
          onSelect();
        }
      }}
      data-testid={testId}
      data-checked={checked ? 'true' : 'false'}
      sx={{
        display: 'flex',
        gap: 1,
        alignItems: 'flex-start',
        px: 1,
        py: 0.75,
        borderRadius: 'sm',
        cursor: 'pointer',
        bgcolor: checked ? 'primary.softActiveBg' : 'background.surface',
        border: '1px solid',
        borderColor: checked ? 'primary.solidBg' : 'transparent',
        '&:hover': { bgcolor: checked ? 'primary.softActiveBg' : 'background.level1' },
      }}
    >
      <Typography level="body-xs" textColor="text.tertiary" sx={{ minWidth: 14, pt: '1px' }}>
        {index}
      </Typography>
      <Box
        aria-hidden
        sx={{
          flex: '0 0 auto',
          width: 14,
          height: 14,
          mt: '2px',
          borderRadius: multi ? '3px' : '50%',
          border: '2px solid',
          borderColor: checked ? 'primary.solidBg' : 'neutral.outlinedBorder',
          bgcolor: checked ? 'primary.solidBg' : 'transparent',
        }}
      />
      <Box sx={{ minWidth: 0, flex: 1 }}>{children}</Box>
    </Box>
  );
}

/**
 * The card for an `ask_user` call: the turn is parked on it until the user answers or skips.
 *
 * Number keys pick an option of the highlighted question (the Other row is the number after the
 * last option), Enter submits once every question has an answer. Keys typed into the Other field
 * are left alone, except Enter.
 */
export function QuestionCard({
  questions,
  onSubmit,
  onSkip,
}: {
  questions: readonly ChatQuestion[];
  onSubmit: (answers: ChatQuestionAnswer[]) => void;
  onSkip: () => void;
}) {
  const [picks, setPicks] = useState<QuestionPick[]>(() => emptyPicks(questions));
  const [active, setActive] = useState(0);
  const card = useRef<HTMLDivElement>(null);
  const otherInputs = useRef<(HTMLInputElement | null)[]>([]);
  const complete = isComplete(picks);

  // Without focus the number keys have nowhere to land, but a card that arrives while the user
  // is mid-sentence in the composer must not take the rest of that sentence.
  useEffect(() => {
    const focused = document.activeElement;
    const typing =
      (focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement) && focused.value.length > 0;
    if (!typing) card.current?.focus();
  }, []);

  const pick = (index: number, label: string) => {
    const next = toggleOption(picks, index, questions[index], label);
    setPicks(next);
    if (!questions[index].multiSelect) setActive(nextUnanswered(next, index));
  };

  const pickOther = (index: number) => {
    setPicks(toggleOther(picks, index, questions[index]));
    setActive(index);
    otherInputs.current[index]?.focus();
  };

  const submit = () => {
    if (complete) onSubmit(toAnswers(picks));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (event.key === 'Enter') {
      if (target.tagName === 'BUTTON') return;
      event.preventDefault();
      submit();
      return;
    }
    if (target.tagName === 'INPUT' || event.metaKey || event.ctrlKey || event.altKey) return;
    const number = Number(event.key);
    if (!Number.isInteger(number) || number < 1) return;
    const question = questions[active];
    if (number <= question.options.length) {
      event.preventDefault();
      pick(active, question.options[number - 1].label);
    } else if (number === question.options.length + 1) {
      event.preventDefault();
      pickOther(active);
    }
  };

  return (
    <Sheet
      ref={card}
      tabIndex={-1}
      variant="soft"
      color="primary"
      onKeyDown={onKeyDown}
      sx={{ borderRadius: 'sm', px: 1.5, py: 1.25, my: 0.5, outline: 'none' }}
      data-testid="chat-question-card"
    >
      <Stack spacing={1.5}>
        {questions.map((question, q) => {
          const state = picks[q];
          return (
            <Box
              key={question.question}
              onClick={() => setActive(q)}
              data-testid={`chat-question-${q}`}
              data-active={q === active ? 'true' : 'false'}
            >
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                <Chip size="sm" variant="solid" color="primary" data-testid={`chat-question-header-${q}`}>
                  {question.header}
                </Chip>
                {question.multiSelect && (
                  <Typography level="body-xs" textColor="text.tertiary">
                    Select all that apply
                  </Typography>
                )}
              </Stack>
              <Typography level="body-sm" fontWeight="lg" sx={{ mb: 0.5 }}>
                {question.question}
              </Typography>
              <Stack spacing={0.5} role={question.multiSelect ? 'group' : 'radiogroup'}>
                {question.options.map((option, o) => (
                  <OptionRow
                    key={option.label}
                    testId={`chat-question-option-${q}-${o}`}
                    checked={state.selected.includes(option.label)}
                    multi={!!question.multiSelect}
                    index={o + 1}
                    onSelect={() => pick(q, option.label)}
                  >
                    <Typography level="body-sm" fontWeight="lg">
                      {option.label}
                    </Typography>
                    <Typography level="body-xs" textColor="text.tertiary">
                      {option.description}
                    </Typography>
                  </OptionRow>
                ))}
                <OptionRow
                  testId={`chat-question-other-${q}`}
                  checked={state.otherOn}
                  multi={!!question.multiSelect}
                  index={question.options.length + 1}
                  onSelect={() => pickOther(q)}
                >
                  <Typography level="body-sm" fontWeight="lg">
                    Other
                  </Typography>
                  <Input
                    size="sm"
                    placeholder="Type your own answer"
                    value={state.other}
                    onClick={event => event.stopPropagation()}
                    onFocus={() => setActive(q)}
                    onChange={event => setPicks(typeOther(picks, q, question, event.target.value))}
                    slotProps={{
                      input: {
                        'data-testid': `chat-question-other-input-${q}`,
                        ref: (element: HTMLInputElement | null) => {
                          otherInputs.current[q] = element;
                        },
                      },
                    }}
                    sx={{ mt: 0.5 }}
                  />
                </OptionRow>
              </Stack>
            </Box>
          );
        })}
      </Stack>

      <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
        <Button size="sm" disabled={!complete} onClick={submit} data-testid="chat-question-submit">
          Submit
        </Button>
        <Button size="sm" variant="plain" color="neutral" onClick={onSkip} data-testid="chat-question-skip">
          Skip
        </Button>
        {!complete && picks.some(isAnswered) && (
          <Typography level="body-xs" textColor="text.tertiary" sx={{ alignSelf: 'center' }}>
            Answer every question to submit.
          </Typography>
        )}
      </Stack>
    </Sheet>
  );
}

/** The settled call, as a record of what was asked and what the user said. */
export function QuestionSummary({
  questions,
  answers,
  note,
}: {
  questions: readonly ChatQuestion[];
  answers?: readonly ChatQuestionAnswer[];
  note?: string;
}) {
  return (
    <Stack spacing={0.75} data-testid="chat-question-summary">
      {questions.map((question, q) => {
        const answer = answers?.[q];
        const parts = [...(answer?.selected ?? []), ...(answer?.other ? [answer.other] : [])];
        return (
          <Box key={question.question}>
            <Typography level="body-xs" textColor="text.secondary">
              <Chip size="sm" variant="soft" sx={{ mr: 0.75 }}>
                {question.header}
              </Chip>
              {question.question}
            </Typography>
            {answers && (
              <Typography level="body-xs" fontWeight="lg" data-testid={`chat-question-answer-${q}`}>
                {parts.length > 0 ? parts.join(', ') : 'No answer'}
              </Typography>
            )}
          </Box>
        );
      })}
      {note && (
        <Typography level="body-xs" textColor="text.tertiary" data-testid="chat-question-note">
          {note}
        </Typography>
      )}
    </Stack>
  );
}
