import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { UserQuestionPayload, UserQuestionResponse, UserQuestionAnswer } from '@bike4mind/services';

export interface UserQuestionPromptProps {
  payload: UserQuestionPayload;
  onResponse: (response: UserQuestionResponse) => void;
}

/**
 * Interactive question prompt component.
 *
 * Pages through questions one at a time. Supports single-select and
 * multi-select modes. Always appends an "Other..." free-text option.
 *
 * When "Other..." is highlighted, an inline text input appears. Arrow keys
 * still navigate away - the text is preserved if you come back.
 *
 * Keyboard: arrow keys to navigate, number keys as shortcuts,
 * Space to toggle (multi-select), Enter to confirm.
 */
export function UserQuestionPrompt({ payload, onResponse }: UserQuestionPromptProps) {
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<UserQuestionAnswer[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [multiSelected, setMultiSelected] = useState<Set<number>>(new Set());
  const [otherText, setOtherText] = useState('');
  const [done, setDone] = useState(false);

  const currentQuestion = payload.questions[questionIndex];
  // Options = LLM options + "Other..."
  const options = [...currentQuestion.options, { label: 'Other...', description: 'Provide your own answer' }];
  const otherIndex = options.length - 1;
  const isMulti = currentQuestion.multiSelect;
  const isOnOther = selectedIndex === otherIndex;

  const advanceToNextQuestion = useCallback(
    (answer: UserQuestionAnswer) => {
      const updatedAnswers = [...answers, answer];

      if (questionIndex + 1 >= payload.questions.length) {
        setDone(true);
        onResponse({ answers: updatedAnswers });
      } else {
        setAnswers(updatedAnswers);
        setQuestionIndex(questionIndex + 1);
        setSelectedIndex(0);
        setMultiSelected(new Set());
        setOtherText('');
      }
    },
    [answers, questionIndex, payload.questions.length, onResponse]
  );

  const submitOther = useCallback(() => {
    if (done) return;
    const text = otherText.trim();
    if (!text) return;

    if (isMulti) {
      const selected = Array.from(multiSelected)
        .filter(i => i !== otherIndex)
        .map(i => options[i].label);
      selected.push(text);
      advanceToNextQuestion({ question: currentQuestion.question, selected });
    } else {
      advanceToNextQuestion({ question: currentQuestion.question, selected: [text] });
    }
  }, [done, otherText, isMulti, multiSelected, otherIndex, options, currentQuestion, advanceToNextQuestion]);

  const confirmSelection = useCallback(() => {
    if (done) return;

    if (isMulti) {
      // Multi-select: gather all toggled items (include Other text if toggled)
      const selected = Array.from(multiSelected)
        .filter(i => i !== otherIndex)
        .map(i => options[i].label);
      if (multiSelected.has(otherIndex) && otherText.trim()) {
        selected.push(otherText.trim());
      }
      if (selected.length === 0) return;
      advanceToNextQuestion({ question: currentQuestion.question, selected });
    } else if (isOnOther) {
      submitOther();
    } else {
      advanceToNextQuestion({
        question: currentQuestion.question,
        selected: [options[selectedIndex].label],
      });
    }
  }, [
    done,
    isMulti,
    multiSelected,
    selectedIndex,
    otherIndex,
    isOnOther,
    options,
    otherText,
    currentQuestion,
    advanceToNextQuestion,
    submitOther,
  ]);

  // Main keyboard handler - always active (not disabled when on Other)
  useInput(
    (input, key) => {
      if (done) return;

      // Arrow keys always work for navigation, even when on "Other..."
      if (key.upArrow) {
        setSelectedIndex(i => (i > 0 ? i - 1 : options.length - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIndex(i => (i < options.length - 1 ? i + 1 : 0));
        return;
      }

      // When on "Other...", only handle Enter (let TextInput handle the rest)
      if (isOnOther) {
        if (key.return) {
          confirmSelection();
        }
        // Don't process number keys etc. - they go into the text input
        return;
      }

      // Number shortcuts (1-based) - only when NOT on Other
      const num = parseInt(input, 10);
      if (num >= 1 && num <= options.length) {
        const idx = num - 1;
        if (isMulti) {
          setMultiSelected(prev => {
            const next = new Set(prev);
            if (next.has(idx)) next.delete(idx);
            else next.add(idx);
            return next;
          });
          setSelectedIndex(idx);
        } else if (idx === otherIndex) {
          setSelectedIndex(idx);
        } else {
          advanceToNextQuestion({
            question: currentQuestion.question,
            selected: [options[idx].label],
          });
        }
        return;
      }

      if (input === ' ' && isMulti) {
        setMultiSelected(prev => {
          const next = new Set(prev);
          if (next.has(selectedIndex)) next.delete(selectedIndex);
          else next.add(selectedIndex);
          return next;
        });
      } else if (key.return) {
        confirmSelection();
      }
    },
    { isActive: !done }
  );

  if (done) return null;

  const totalQuestions = payload.questions.length;

  return (
    <Box flexDirection="column" borderStyle="bold" borderColor="cyan" padding={1} marginY={1}>
      {/* Header */}
      <Box>
        <Text bold color="cyan">
          ? Question{totalQuestions > 1 ? ` ${questionIndex + 1}/${totalQuestions}` : ''}
        </Text>
      </Box>

      {/* Question text */}
      <Box marginTop={1}>
        <Text bold>{currentQuestion.question}</Text>
      </Box>

      {/* Options */}
      <Box marginTop={1} flexDirection="column">
        {options.map((opt, idx) => {
          const isHighlighted = idx === selectedIndex;
          const isToggled = isMulti && multiSelected.has(idx);
          const prefix = isMulti ? (isToggled ? '[x]' : '[ ]') : isHighlighted ? ' > ' : '   ';

          return (
            <Box key={idx}>
              <Text color="cyan">{idx + 1}.</Text>
              <Text color={isHighlighted ? 'cyan' : undefined} bold={isHighlighted}>
                {' '}
                {prefix} {opt.label}
              </Text>
              {/* Inline text input on the same line as Other */}
              {idx === otherIndex && isHighlighted ? (
                <Box marginLeft={1}>
                  <TextInput
                    value={otherText}
                    onChange={setOtherText}
                    onSubmit={submitOther}
                    placeholder="Type your answer..."
                  />
                </Box>
              ) : (
                opt.description && idx !== otherIndex && <Text dimColor> - {opt.description}</Text>
              )}
            </Box>
          );
        })}
      </Box>

      {/* Keyboard hints */}
      <Box marginTop={1}>
        <Text dimColor>
          {isOnOther
            ? 'Type your answer, Enter to submit, or arrow keys to go back'
            : isMulti
              ? 'Press 1-' + options.length + ', Space to toggle, Enter to confirm'
              : 'Press 1-' + options.length + ', or arrow keys + Enter'}
        </Text>
      </Box>
    </Box>
  );
}
