import SimulatedPcmSource from "./sources/SimulatedPcmSource.js";
import PcmSource from "./PcmSource.js";

async function test() {
  try {
    const source = new SimulatedPcmSource({ durationS: 2.0, pattern: 'mixed' });
    const pcmData = await source.acquire();
    console.log("Acquired PCM Data:", {
      sampleRate: pcmData.sampleRate,
      channels: pcmData.channels,
      sourceType: pcmData.sourceType,
      sourceId: pcmData.sourceId,
      samplesLength: pcmData.samples.length,
    });
    
    const validation = PcmSource.validate(pcmData);
    console.log("Validation Result:", validation);
    
  } catch (error) {
    console.error("Test failed:", error);
  }
}

test();
