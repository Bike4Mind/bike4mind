/** Debounce margin for model search input (ModelSelection.tsx uses a 500ms debounce). */
export const MODEL_SEARCH_DEBOUNCE_MS = 600;

/** Centralized timeout constants for E2E tests (in milliseconds). */
export const TIMEOUTS = {
  /** Short UI transitions and state settling */
  UI_SETTLE: 500,
  /** Post-operation waits for rendering */
  POST_ACTION: 2_000,
  /** Quick element state checks (button enabled, modal close) */
  ELEMENT_STATE: 5_000,
  /** Modal appearance/dismissal */
  MODAL: 8_000,
  /** Standard element visibility assertions */
  VISIBLE: 10_000,
  /** Page-level navigation and form flows */
  NAVIGATION: 15_000,
  /** Major operations: URL changes, API responses, file uploads */
  ACTION: 30_000,
  /** Default for verifyAnswers fixture */
  VERIFY_ANSWER: 50_000,
  /** Global test timeout (also set in playwright.config.ts) */
  TEST: 60_000,
  /** Spinners and loading indicators to disappear */
  LOADER_HIDDEN: 120_000,
  /** AI streaming text responses */
  AI_RESPONSE: 120_000,
  /**
   * Image generation - slower than text; the model can take several minutes under load.
   * Note: streaming "completes" (stop-generation-btn disappears) well before the image
   * actually renders, so nearly the whole generation time is spent in waitForImageResponse.
   * In CI this regularly exceeds 4 min, so the budget must cover the full generation,
   * not just the streaming phase.
   */
  IMAGE_GENERATION: 360_000,
} as const;
