// silence-detector-processor.js
class SilenceDetectorProcessor extends AudioWorkletProcessor {
  silenceThreshold; // Define your silence threshold here
  framesOfSilence; // Count consecutive frames of silence
  frameCount; // Add a property to count the processed frames
  delayFrames; // Number of frames to delay silence detection


  constructor() {
    super();
    this.silenceThreshold = 0.01; // Define your silence threshold here
    this.framesOfSilence = 0; // Count consecutive frames of silence
    this.frameCount = 0;
    const delayTimeInSeconds = 5; // Delay silence detection for 5 seconds
    this.delayFrames = delayTimeInSeconds * sampleRate; // Calculate the delay in frames
  }

  process(inputs) {
    // Increment frame count
    this.frameCount += inputs[0][0].length;

    // This makes it so the audio won't pick up silence on the start-
    // and actually gives the user time to start a dialogue.
    // Check if the delay period has passed
    if (this.frameCount < this.delayFrames) {
      return true; // Skip processing if within the delay period
    }

    const input = inputs[0];

    if (input.length > 0) {
      const samples = input[0];
      let sum = 0;
      for (let i = 0; i < samples.length; i++) {
        sum += samples[i] * samples[i];
      }
      const rms = Math.sqrt(sum / samples.length);

      // this checks for what we consider as silence
      if (rms < this.silenceThreshold) {
        this.framesOfSilence++;
        if (this.framesOfSilence >= 500) {
          // Adjust this value based on your needs
          this.port.postMessage('silence');
          return false;
        }
      } else {
        this.framesOfSilence = 0;
      }
    }
    return true;
  }
}

registerProcessor('silence-detector-processor', SilenceDetectorProcessor);
