/** Whether What's New has opened in this page load; read by the gears discovery modal so the two never share a visit. */
let shown = false;

export const markWhatsNewShown = () => {
  shown = true;
};

export const wasWhatsNewShown = () => shown;

export const resetWhatsNewShownForTests = () => {
  shown = false;
};
