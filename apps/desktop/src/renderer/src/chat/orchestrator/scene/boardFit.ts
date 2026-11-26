/**
 * Splits `items` into the notes pinned on a board with room for `capacity`, and the rest. Like a full
 * zone's overflow stack, a board that cannot fit everything gives its last place to a "+N" note.
 */
export function pinNotes<T>(items: readonly T[], capacity: number): { pinned: T[]; hidden: T[] } {
  if (items.length <= capacity) return { pinned: [...items], hidden: [] };
  const room = Math.max(0, capacity - 1);
  return { pinned: items.slice(0, room), hidden: items.slice(room) };
}

// The board's vertical metrics, in cqh (1% of the scene height) unless noted. Must stay in sync with
// the paddings, gaps and font in QuestBoard.tsx, whose note font is clamp(7px, 1.5cqh, 10px).
const NOTE_FONT_CQH = 1.5;
const NOTE_FONT_MIN_PX = 7;
const NOTE_FONT_MAX_PX = 10;
const NOTE_GAP_CQH = 0.9;
const NOTE_PAD_CQH = 0.9;
const MORE_PAD_CQH = 0.8;
// Frame padding (0.4 top, 0.7 bottom), the header's gap and cork padding (0.6 top and bottom).
const BOARD_CHROME_CQH = 0.4 + 0.7 + NOTE_GAP_CQH + 1.2;
const HEADER_LINES = 1.3;
const NOTE_LINES = 2.4;
const MORE_LINES = 1.2;
const FIT_SLACK_PX = 2;

/**
 * How many notes (the "+N" note counts as one, as in `pinNotes`) a board `boardHeightPx` tall holds
 * for `total` quests. The note font has a pixel floor, so on a small scene a fixed count overruns
 * the board; this shrinks the count until the pinned notes and the "+N" note fit. 0 means not even
 * the "+N" note fits, so the board is too small to be of use and should not be drawn. `board.height`
 * is the board's share of the scene height (percent) and `board.notes` the most it ever pins.
 */
export function noteCapacity(boardHeightPx: number, total: number, board: { height: number; notes: number }): number {
  const max = board.notes;
  const unit = boardHeightPx / board.height; // px per percent of the scene height
  const font = Math.min(NOTE_FONT_MAX_PX, Math.max(NOTE_FONT_MIN_PX, NOTE_FONT_CQH * unit));
  const room = boardHeightPx - BOARD_CHROME_CQH * unit - HEADER_LINES * font - FIT_SLACK_PX;
  const stack = (pinned: number, more: boolean) => {
    const places = pinned + (more ? 1 : 0);
    const notes = pinned * (NOTE_LINES * font + NOTE_PAD_CQH * unit);
    const moreNote = more ? MORE_LINES * font + MORE_PAD_CQH * unit : 0;
    return notes + moreNote + Math.max(0, places - 1) * NOTE_GAP_CQH * unit;
  };
  if (total <= max && stack(total, false) <= room) return total;
  for (let pinned = Math.min(total, max) - 1; pinned >= 0; pinned--) {
    if (pinned + 1 >= total) continue; // a capacity of `total` must mean the full stack fits
    if (stack(pinned, true) <= room) return pinned + 1;
  }
  return 0;
}
