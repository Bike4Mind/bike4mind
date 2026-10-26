/** Which of What's New and the gears discovery modal has opened in this page load, so the two never share one. */
let whatsNewShown = false;
let gearsDiscoveryShown = false;

export const markWhatsNewShown = () => {
  whatsNewShown = true;
};

export const wasWhatsNewShown = () => whatsNewShown;

export const markGearsDiscoveryShown = () => {
  gearsDiscoveryShown = true;
};

export const wasGearsDiscoveryShown = () => gearsDiscoveryShown;

export const resetWhatsNewShownForTests = () => {
  whatsNewShown = false;
  gearsDiscoveryShown = false;
};
