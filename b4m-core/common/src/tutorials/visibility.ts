/** Who may see a core tutorial. The entitlement is a plain key, so common names no entitlement. */
export type CoreTutorialVisibility = { entitlement: string } | { public: true };
