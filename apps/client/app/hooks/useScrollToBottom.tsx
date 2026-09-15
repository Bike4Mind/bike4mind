const scrollToBottom = (element: HTMLDivElement | null, duration: number = 500, callback?: () => void) => {
  const startTime = performance.now();

  const step = (currentTime: number) => {
    const elapsedTime = currentTime - startTime;
    const progress = Math.min(elapsedTime / duration, 1);
    if (element) {
      element.scrollTop = element.scrollHeight;

      if (progress < 1) {
        requestAnimationFrame(step);
      } else {
        if (typeof callback === 'function') {
          callback();
        }
      }
    }
  };
  requestAnimationFrame(step);
};

export default scrollToBottom;
