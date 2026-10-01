/**
 * pipeline/InferencePipeline.js
 *
 * Orchestrates the full PRISM inference pipeline:
 *   PCM → DSP → Windows → ONNX → Events → Features → Score → Result
 *
 * Each stage is a separate method so it can be implemented, tested,
 * and validated independently (Stages 2–12 of the plan).
 *
 * Currently all processing methods are stubs that define the interface.
 * They will be filled in by subsequent stages.
 *
 * The pipeline does NOT depend on React, Firebase, or BLE.
 * It accepts PcmData and returns a RecordingResult.
 */

import PcmSource from "./PcmSource.js";
import {
  PIPELINE_CONFIG,
  CURRENT_VERSIONS,
  RECORDING_STATUS,
  EVENT_STATUS,
  V2_FEATURE_ORDER,
  SCORE_INTERPRETATION,
  ERROR_CODES,
} from "./versions.js";

export default class InferencePipeline {
  constructor() {
    /** @type {boolean} */
    this._modelLoaded = false;
    /** @type {Object|null} */
    this._baseline = null;
  }

  // ─── Main Entry Point ──────────────────────────────────────────────────────

  /**
   * Run the full inference pipeline on PCM audio from any source.
   *
   * @param {import('./PcmSource').default} source - A PcmSource subclass instance
   * @returns {Promise<import('./types').RecordingResult>}
   */
  async run(source) {
    // 1. Acquire PCM from source
    const pcmData = await source.acquire();

    // 2. Validate input
    const validation = PcmSource.validate(pcmData);
    if (!validation.valid) {
      return this._inputErrorResult(pcmData, validation.errors.join("; "));
    }

    // 3. Extract frame features (124-dim per frame)
    const frameFeatures = await this.extractFrameFeatures(pcmData);

    // 4. Build CNN sliding windows ([N, 25, 124])
    const windows = this.buildWindows(frameFeatures);

    if (windows.length === 0) {
      return this._inputErrorResult(
        pcmData,
        ERROR_CODES.SHORTER_THAN_ONE_WINDOW
      );
    }

    // 5. Run ONNX inference
    const predictions = await this.runInference(windows);

    // 6. Decode temporal events (group Inhale predictions)
    const events = this.decodeEvents(predictions, pcmData);

    if (events.length === 0) {
      return this._noInhalationResult(pcmData);
    }

    // 7. For each event: extract features, check scoreability, score
    const eventResults = [];
    for (const event of events) {
      const eventResult = await this.processEvent(event, pcmData);
      eventResults.push(eventResult);
    }

    // 8. Build recording-level result
    return this._eventsDetectedResult(pcmData, eventResults);
  }

  // ─── Pipeline Stage Methods (stubs) ────────────────────────────────────────

  /**
   * Stage 3: Extract 124-dim frame features from PCM.
   *
   * @param {import('./types').PcmData} pcmData
   * @returns {Promise<import('./types').FrameFeatures[]>}
   */
  async extractFrameFeatures(pcmData) {
    if (!this._dspEngine) {
      // Lazy load to avoid importing DSP constants if not needed
      const { DspEngine } = await import('./dsp.js');
      this._dspEngine = new DspEngine();
    }
    return this._dspEngine.processPcm(pcmData.samples);
  }

  /**
   * Stage 5: Build [25, 124] sliding windows from frame features.
   *
   * @param {import('./types').FrameFeatures[]} frameFeatures
   * @returns {import('./types').CnnWindow[]}
   */
  buildWindows(frameFeatures) {
    const windows = [];
    const windowSize = PIPELINE_CONFIG.windowSize; // 25
    const stride = PIPELINE_CONFIG.windowStride; // 2
    
    if (frameFeatures.length < windowSize) {
      return windows;
    }
    
    const numWindows = Math.floor((frameFeatures.length - windowSize) / stride) + 1;
    const numFeats = 124; // Constant 124-dim features
    
    for (let w = 0; w < numWindows; w++) {
      const startIndex = w * stride;
      const endIndex = startIndex + windowSize;
      
      const tensor = new Float32Array(windowSize * numFeats);
      let ptr = 0;
      
      for (let f = startIndex; f < endIndex; f++) {
        tensor.set(frameFeatures[f].features, ptr);
        ptr += numFeats;
      }
      
      windows.push({
        windowIndex: w,
        tensor: tensor,
        startTime: frameFeatures[startIndex].timestamp,
        // The endTime of the window is the timestamp of the last frame in the window,
        // plus the hop size (which represents the physical time covered by that last frame's stride).
        // For simplicity we just use the timestamp of the last frame + hop duration.
        // Assuming 8000Hz and hop=64, hop duration = 0.008s.
        endTime: frameFeatures[endIndex - 1].timestamp + (64.0 / 8000.0)
      });
    }
    
    return windows;
  }

  /**
   * Stage 2/6: Run ONNX model inference on windows.
   *
   * @param {import('./types').CnnWindow[]} windows
   * @returns {Promise<import('./types').WindowPrediction[]>}
   */
  async runInference(windows) {
    if (windows.length === 0) return [];

    // Dynamically load ONNX runtime to avoid breaking Node.js test scripts
    // that don't have React Native environment. In a real RN app, this uses
    // onnxruntime-react-native. In Node, it falls back to onnxruntime-node.
    let ort;
    try {
      if (typeof navigator !== 'undefined' && navigator.product === 'ReactNative') {
        ort = require('onnxruntime-react-native');
      } else {
        ort = await import('onnxruntime-node');
        // Handle commonjs module default export if needed
        if (ort.default) ort = ort.default;
      }
    } catch (e) {
      throw new Error(`Failed to load ONNX runtime: ${e.message}`);
    }

    if (!this._baseline) {
      // Load model if not loaded (caching the session in a real implementation)
      // Note: In RN, the model path comes from require(), in Node from a string path.
      const modelPath = typeof navigator !== 'undefined' && navigator.product === 'ReactNative' 
        ? require('../assets/ml/inhaler_cnn.onnx') 
        : './assets/ml/inhaler_cnn.onnx';
        
      this._baseline = await ort.InferenceSession.create(modelPath);
    }
    
    const session = this._baseline;
    const inputName = session.inputNames[0]; // 'features'
    const outputName = session.outputNames[0]; // 'logits'

    const predictions = [];

    // Process each window
    for (const window of windows) {
      // Shape: [1, 25, 124]
      const tensor = new ort.Tensor('float32', window.tensor, [1, 25, 124]);
      const feeds = {};
      feeds[inputName] = tensor;

      const results = await session.run(feeds);
      const logits = results[outputName].data; // Float32Array(4)

      // Softmax
      let maxLogit = -Infinity;
      for (let i = 0; i < logits.length; i++) {
        if (logits[i] > maxLogit) maxLogit = logits[i];
      }
      
      let sumExp = 0;
      const probs = new Float32Array(logits.length);
      for (let i = 0; i < logits.length; i++) {
        probs[i] = Math.exp(logits[i] - maxLogit);
        sumExp += probs[i];
      }
      
      let predictedClass = -1;
      let maxProb = -1;
      for (let i = 0; i < logits.length; i++) {
        probs[i] /= sumExp;
        if (probs[i] > maxProb) {
          maxProb = probs[i];
          predictedClass = i;
        }
      }

      predictions.push({
        windowIndex: window.windowIndex,
        logits: new Float32Array(logits),
        probabilities: probs,
        predictedClass: predictedClass,
        predictedLabel: PIPELINE_CONFIG.classLabels[predictedClass],
        startTime: window.startTime,
        endTime: window.endTime,
      });
    }

    return predictions;
  }

  /**
   * Stage 8: Decode window predictions into inhalation event intervals.
   *
   * @param {import('./types').WindowPrediction[]} predictions
   * @param {import('./types').PcmData} pcmData
   * @returns {import('./types').DecodedEvent[]}
   */
  decodeEvents(predictions, pcmData) {
    if (predictions.length === 0) return [];
    
    // 1. Filter to Inhale predictions (Class index 2)
    const inhaleWins = predictions.filter(p => p.predictedClass === 2);
    if (inhaleWins.length === 0) return [];
    
    // Sort chronologically (should already be sorted, but to be safe)
    inhaleWins.sort((a, b) => a.startTime - b.startTime);
    
    const events = [];
    let currentEvent = null;
    let eventId = 0;
    
    for (const win of inhaleWins) {
      if (!currentEvent) {
        currentEvent = { windows: [win], end: win.endTime };
      } else {
        // A window joins if its start <= the latest end of the event's windows
        if (win.startTime <= currentEvent.end + 1e-6) {
          currentEvent.windows.push(win);
          currentEvent.end = Math.max(currentEvent.end, win.endTime);
        } else {
          // Finish current event
          events.push(this._finalizeEvent(currentEvent, eventId++, pcmData));
          
          // Start new event
          currentEvent = { windows: [win], end: win.endTime };
        }
      }
    }
    
    if (currentEvent) {
      events.push(this._finalizeEvent(currentEvent, eventId++, pcmData));
    }
    
    return events;
  }
  
  /**
   * Helper to build the final event structure from grouped windows
   * @private
   */
  _finalizeEvent(eventGroup, eventId, pcmData) {
    const wins = eventGroup.windows;
    const start = wins[0].startTime;
    let end = start;
    let sumProb = 0;
    let maxProb = 0;
    
    for (const win of wins) {
      end = Math.max(end, win.endTime);
      const prob = win.probabilities[2]; // P(Inhale)
      sumProb += prob;
      if (prob > maxProb) maxProb = prob;
    }
    
    const duration = end - start;
    const meanProb = sumProb / wins.length;
    
    return {
      eventId: eventId,
      startS: start,
      endS: end,
      durationS: duration,
      detectorConfidence: meanProb,
      detectorMaxConfidence: maxProb,
      windowPredictions: wins,
      // Metadata/Results populated in later stages
      scoreable: false,
      notScoreableReasons: [],
      eventFeatures: null,
      score: null
    };
  }

  /**
   * Stages 9-12: Process a single decoded event through feature extraction,
   * scoreability check, and anomaly scoring.
   *
   * @param {import('./types').DecodedEvent} event
   * @param {import('./types').PcmData} pcmData
   * @returns {Promise<import('./types').EventResult>}
   */
  async processEvent(event, pcmData) {
    // 9. Extract event PCM segment
    const eventPcm = this.extractEventPcm(event, pcmData);

    // 10. Extract event-level features (V2)
    const features = await this.extractEventFeatures(eventPcm);

    // 7. Check scoreability (Stage 1 usability rule)
    const scoreability = this.checkScoreability(event, pcmData, features);

    if (!scoreability.isScoreable) {
      return this._notScoreableEventResult(event, scoreability, features);
    }

    // 12. Score against baseline
    const scoring = this.scoreEvent(features);

    return this._scoredEventResult(event, features, scoring);
  }

  /**
   * Stage 9: Extract the raw PCM segment for one event.
   *
   * @param {import('./types').DecodedEvent} event
   * @param {import('./types').PcmData} pcmData
   * @returns {Float32Array} Event PCM samples
   */
  extractEventPcm(event, pcmData) {
    const sr = pcmData.sampleRate;
    
    // Calculate sample indices
    let startIdx = Math.floor(event.startS * sr);
    let endIdx = Math.ceil(event.endS * sr);
    
    // Clamp to valid range
    startIdx = Math.max(0, startIdx);
    endIdx = Math.min(pcmData.samples.length, endIdx);
    
    // Ensure valid slice
    if (startIdx >= endIdx) {
      return new Float32Array(0);
    }
    
    // Return a copy or view? subarray creates a view (no allocation overhead).
    // Using slice() creates a copy, but subarray() is more efficient and safe
    // as long as we only read it in subsequent stages.
    return pcmData.samples.subarray(startIdx, endIdx);
  }

  /**
   * Stage 10: Extract V2 event-level features from event PCM.
   *
   * @param {Float32Array} eventPcm
   * @returns {Promise<import('./types').EventFeatures>}
   */
  async extractEventFeatures(eventPcm) {
    if (!this._featureExtractor) {
      const { FeatureExtractor } = await import('./FeatureExtractor.js');
      this._featureExtractor = new FeatureExtractor();
    }
    return this._featureExtractor.extractFeatures(eventPcm);
  }

  /**
   * Stage 7 (scoreability): Check if an event passes the usability rule.
   *
   * @param {import('./types').DecodedEvent} event
   * @param {import('./types').PcmData} pcmData
   * @param {import('./types').EventFeatures} features
   * @returns {import('./types').EventScoreability}
   */
  checkScoreability(event, pcmData, features) {
    // TODO: Will be implemented alongside event features
    throw new Error("checkScoreability() not yet implemented.");
  }

  /**
   * Stage 12: Compute anomaly score against the baseline.
   *
   * @param {import('./types').EventFeatures} features
   * @returns {{ anomalyScore: number, featureZScores: import('./types').FeatureZScores }}
   */
  scoreEvent(features) {
    // TODO: Stage 12 — Score-Only Anomaly Engine
    throw new Error("scoreEvent() not yet implemented (Stage 12).");
  }

  // ─── Result Builders ───────────────────────────────────────────────────────

  /**
   * Build an INPUT_ERROR recording result.
   * @param {import('./types').PcmData} pcmData
   * @param {string} errorMsg
   * @returns {import('./types').RecordingResult}
   */
  _inputErrorResult(pcmData, errorMsg) {
    return {
      contractVersion: CURRENT_VERSIONS.inferenceContractVersion,
      baselineId: CURRENT_VERSIONS.baselineVersion,
      recordingStatus: RECORDING_STATUS.INPUT_ERROR,
      error: errorMsg,
      input: this._buildInputMeta(pcmData),
      baselineDomainValidated: false,
      featureOrder: [...V2_FEATURE_ORDER],
      nEvents: 0,
      nScored: 0,
      events: [],
      interpretation: SCORE_INTERPRETATION,
      versions: { ...CURRENT_VERSIONS },
    };
  }

  /**
   * Build a NO_INHALATION_DETECTED recording result.
   * @param {import('./types').PcmData} pcmData
   * @returns {import('./types').RecordingResult}
   */
  _noInhalationResult(pcmData) {
    return {
      contractVersion: CURRENT_VERSIONS.inferenceContractVersion,
      baselineId: CURRENT_VERSIONS.baselineVersion,
      recordingStatus: RECORDING_STATUS.NO_INHALATION_DETECTED,
      error: null,
      input: this._buildInputMeta(pcmData),
      baselineDomainValidated: false,
      featureOrder: [...V2_FEATURE_ORDER],
      nEvents: 0,
      nScored: 0,
      events: [],
      interpretation: SCORE_INTERPRETATION,
      versions: { ...CURRENT_VERSIONS },
    };
  }

  /**
   * Build an EVENTS_DETECTED recording result.
   * @param {import('./types').PcmData} pcmData
   * @param {import('./types').EventResult[]} eventResults
   * @returns {import('./types').RecordingResult}
   */
  _eventsDetectedResult(pcmData, eventResults) {
    const nScored = eventResults.filter(
      (e) => e.status === EVENT_STATUS.SCORE_ONLY
    ).length;

    return {
      contractVersion: CURRENT_VERSIONS.inferenceContractVersion,
      baselineId: CURRENT_VERSIONS.baselineVersion,
      recordingStatus: RECORDING_STATUS.EVENTS_DETECTED,
      error: null,
      input: this._buildInputMeta(pcmData),
      baselineDomainValidated: false,
      featureOrder: [...V2_FEATURE_ORDER],
      nEvents: eventResults.length,
      nScored,
      events: eventResults,
      interpretation: SCORE_INTERPRETATION,
      versions: { ...CURRENT_VERSIONS },
    };
  }

  /**
   * Build a NOT_SCOREABLE event result.
   * @param {import('./types').DecodedEvent} event
   * @param {import('./types').EventScoreability} scoreability
   * @param {import('./types').EventFeatures} features
   * @returns {import('./types').EventResult}
   */
  _notScoreableEventResult(event, scoreability, features) {
    return {
      eventId: event.eventId,
      startTime: event.startTime,
      endTime: event.endTime,
      durationS: event.durationS,
      detectorConfidence: event.detectorConfidence,
      detectorMaxConfidence: event.detectorMaxConfidence,
      windowCount: event.windowCount,
      status: EVENT_STATUS.NOT_SCOREABLE,
      notScoreableReasons: scoreability.notScoreableReasons,
      anomalyScore: null,
      featureValues: null,
      featureZScores: null,
      meanRms: features?.meanRms ?? null,
    };
  }

  /**
   * Build a SCORE_ONLY event result.
   * @param {import('./types').DecodedEvent} event
   * @param {import('./types').EventFeatures} features
   * @param {{ anomalyScore: number, featureZScores: import('./types').FeatureZScores }} scoring
   * @returns {import('./types').EventResult}
   */
  _scoredEventResult(event, features, scoring) {
    return {
      eventId: event.eventId,
      startTime: event.startTime,
      endTime: event.endTime,
      durationS: event.durationS,
      detectorConfidence: event.detectorConfidence,
      detectorMaxConfidence: event.detectorMaxConfidence,
      windowCount: event.windowCount,
      status: EVENT_STATUS.SCORE_ONLY,
      notScoreableReasons: [],
      anomalyScore: scoring.anomalyScore,
      featureValues: features.anomalyFeatures,
      featureZScores: scoring.featureZScores,
      meanRms: features.meanRms,
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Build input metadata for the recording result.
   * @param {import('./types').PcmData} pcmData
   * @returns {import('./types').RecordingInput}
   */
  _buildInputMeta(pcmData) {
    return {
      sampleRate: pcmData.sampleRate,
      nSamples: pcmData.samples.length,
      durationS: pcmData.samples.length / pcmData.sampleRate,
      inputDomain: "unknown",
      recordingId: pcmData.sourceId,
      recordedAt: pcmData.recordedAt,
    };
  }
}
