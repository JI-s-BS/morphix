// Collects microphone samples on the audio thread and posts them as Float32 blocks.
class PcmRecorder extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("pcm-recorder", PcmRecorder);
