/**
 * pipeline/InferencePipeline.js
 *
 * The PRISM V2 inference contract (prism-inference-v2.0) on the device:
 *   PCM → DSP (124-dim frames) → CNN windows → ONNX detector → Inhale events
 *       → scoreability (usability rule v1) → V2 features + mean_rms
 *       → frozen global baseline → robust z → anomaly_score (SCORE_ONLY)
 *
 * The reference implementation is `prism_inference.analyze_recording` in the research
 * repository (with `post_event.generate_window_predictions` / `group_inhale_events`).
 * run() returns exactly the canonical output object of inference_output.schema.json,
 * validated by contract.validateOutput. There is no other result schema.
 *
 * The pipeline does not depend on React, Firebase, BLE or Node. Platform specifics are
 * injected: the ONNX detector (pipeline/runtime/node.js or pipeline/runtime/reactNative.js)
 * and, optionally, the baseline JSON (default: the bundled v2_baseline.json).
 */

import BaselineStore from "./BaselineStore.js";
import { DspEngine } from "./dsp.js";
import { FeatureExtractor } from "./FeatureExtractor.js";
import {
  checkInput,
  checkInputDomain,
  roundHalfEven,
  rmsZ,
  toIsoOrNull,
  validateOutput,
} from "./contract.js";
import {
  PIPELINE_CONFIG,
  SCOREABILITY_CONFIG,
  RECORDING_STATUS,
  EVENT_STATUS,
  NOT_SCOREABLE_REASONS,
  V2_FEATURE_ORDER,
  INFERENCE_CONTRACT_VERSION,
  SCORE_INTERPRETATION,
  TIME_DECIMALS,
} from "./versions.js";

const INHALE_CLASS = PIPELINE_CONFIG.classLabels.indexOf("Inhale"); // 2

export default class InferencePipeline {
  /**
   * @param {Object} [options]
   * @param {import('./OnnxDetector').default} [options.detector] - verified ONNX detector.
   *   Required by run()/runInference(); create it with createNodeDetector() (Node) or
   *   createReactNativeDetector() (app).
   * @param {Object} [options.baseline] - parsed baseline JSON (default: bundled v2_baseline.json)
   */
  constructor(options = {}) {
    this._detector = options.detector ?? null;
    this._baselineJson = options.baseline ?? undefined;
    this._baseline = null;
    this._dspEngine = null;
    this._featureExtractor = null;
  }

  // ─── Main Entry Point ──────────────────────────────────────────────────────

  /**
   * Apply the inference contract to one recording.
   *
   * Contract states are returned, never thrown: INPUT_ERROR (with its error code),
   * NO_INHALATION_DETECTED and EVENTS_DETECTED. Exceptions mean the pipeline itself could not
   * run (no detector, model verification failed, invalid baseline, unreadable source).
   *
   * @param {import('./PcmSource').default} source - a PcmSource subclass instance
   * @returns {Promise<Object>} the canonical output (inference_output.schema.json)
   */
  async run(source) {
    if (typeof source?.acquire !== "function") {
      throw new TypeError("run() expects a PcmSource (an object with acquire())");
    }
    const detector = this._requireDetector();
    const baseline = await this._getBaseline();
    const pcmData = await source.acquire();
    const inputDomain = checkInputDomain(pcmData?.inputDomain);
    const { error, samples, nSamples } = checkInput(pcmData);

    const sampleRate = pcmData.sampleRate;
    if (!Number.isInteger(sampleRate)) throw new TypeError("PcmData.sampleRate must be an integer");
    const output = {
      contract_version: INFERENCE_CONTRACT_VERSION,
      baseline_id: baseline.baselineId,
      detector_model_sha256: detector.modelSha256,
      recording_status: RECORDING_STATUS.INPUT_ERROR,
      error,
      input: {
        sample_rate: sampleRate,
        n_samples: nSamples,
        duration_s: sampleRate > 0 ? nSamples / sampleRate : null,
        input_domain: inputDomain,
        recording_id: pcmData.sourceId ?? null,
        recorded_at: toIsoOrNull(pcmData.recordedAt),
      },
      baseline_domain_validated: inputDomain === "reference_dataset",
      feature_order: [...V2_FEATURE_ORDER],
      n_events: 0,
      n_scored: 0,
      events: [],
      interpretation: SCORE_INTERPRETATION,
    };

    if (error === null) {
      const pcm = { ...pcmData, samples };
      const frameFeatures = await this.extractFrameFeatures(pcm);
      if (!this._allFinite(frameFeatures)) {
        // The detector's 124-feature frames were not finite (post_event raises ValueError).
        output.error = "detector_feature_extraction_failed";
      } else {
        const windows = this.buildWindows(frameFeatures, samples.length / sampleRate);
        const predictions = await this.runInference(windows);
        const events = this.decodeEvents(predictions, pcm);
        output.events = [];
        for (const event of events) {
          output.events.push(await this.processEvent(event, events, pcm));
        }
        output.recording_status = events.length > 0
          ? RECORDING_STATUS.EVENTS_DETECTED
          : RECORDING_STATUS.NO_INHALATION_DETECTED;
        output.n_events = output.events.length;
        output.n_scored = output.events.filter((e) => e.status === EVENT_STATUS.SCORE_ONLY).length;
      }
    }

    validateOutput(output);
    return output;
  }

  // ─── Pipeline Stage Methods ────────────────────────────────────────────────

  /**
   * Stage 3: Extract 124-dim frame features from PCM.
   *
   * @param {import('./types').PcmData} pcmData
   * @returns {Promise<import('./types').FrameFeatures[]>}
   */
  async extractFrameFeatures(pcmData) {
    if (!this._dspEngine) this._dspEngine = new DspEngine();
    return this._dspEngine.processPcm(pcmData.samples);
  }

  /**
   * Stage 5: Build [25, 124] sliding windows from frame features.
   *
   * Window times follow post_event.generate_window_predictions exactly:
   *   start = i * (2 * 64 / 8000),  end = min(start + 25 * 64 / 8000, recording duration).
   * The event segment is sliced as [floor(start * 8000), ceil(end * 8000)), so the times must
   * be the same floating-point values as the reference's, not merely close to them (F14).
   *
   * @param {import('./types').FrameFeatures[]} frameFeatures
   * @param {number} [recordingDurationS] - len(waveform) / sample_rate; caps the last windows' end.
   *   run() always passes it. Without it the end is not capped (previous behaviour).
   * @returns {import('./types').CnnWindow[]}
   */
  buildWindows(frameFeatures, recordingDurationS) {
    const windows = [];
    const windowSize = PIPELINE_CONFIG.windowSize; // 25
    const stride = PIPELINE_CONFIG.windowStride; // 2
    const numFeats = PIPELINE_CONFIG.featureDim; // 124
    if (frameFeatures.length < windowSize) return windows;

    const hop = PIPELINE_CONFIG.hopLength;
    const sr = PIPELINE_CONFIG.sampleRate;
    const windowDuration = windowSize * hop / sr; // evaluated as (25 * 64) / 8000, as in Python
    const strideDuration = stride * hop / sr; // (2 * 64) / 8000
    const duration = recordingDurationS ?? Infinity;

    const numWindows = Math.floor((frameFeatures.length - windowSize) / stride) + 1;
    for (let w = 0; w < numWindows; w++) {
      const startIndex = w * stride;
      const tensor = new Float32Array(windowSize * numFeats);
      for (let f = 0; f < windowSize; f++) {
        tensor.set(frameFeatures[startIndex + f].features, f * numFeats);
      }
      const startTime = w * strideDuration;
      windows.push({
        windowIndex: w,
        tensor,
        startTime,
        endTime: Math.min(startTime + windowDuration, duration),
      });
    }
    return windows;
  }

  /**
   * Stage 2/6: Run the ONNX detector on every window.
   *
   * Softmax as post_event.OnnxEventClassifier.predict_probabilities: float32 logits are
   * converted to float64, shifted by their max, exponentiated and normalised, and the
   * probabilities are rounded to float32. Label = first argmax.
   *
   * @param {import('./types').CnnWindow[]} windows
   * @returns {Promise<import('./types').WindowPrediction[]>}
   */
  async runInference(windows) {
    if (windows.length === 0) return [];
    const detector = this._requireDetector();
    const predictions = [];
    for (const window of windows) {
      const logits = await detector.logits(window.tensor);
      let maxLogit = -Infinity;
      for (let i = 0; i < logits.length; i++) if (logits[i] > maxLogit) maxLogit = logits[i];
      const exps = Array.from(logits, (v) => Math.exp(v - maxLogit));
      const sumExp = exps.reduce((a, b) => a + b, 0);
      const probabilities = Float32Array.from(exps, (e) => e / sumExp);
      let predictedClass = 0;
      for (let i = 1; i < probabilities.length; i++) {
        if (probabilities[i] > probabilities[predictedClass]) predictedClass = i;
      }
      predictions.push({
        windowIndex: window.windowIndex,
        logits,
        probabilities,
        predictedClass,
        predictedLabel: PIPELINE_CONFIG.classLabels[predictedClass],
        startTime: window.startTime,
        endTime: window.endTime,
      });
    }
    return predictions;
  }

  /**
   * Stage 8: Group Inhale windows into events (post_event.group_inhale_events with the
   * contract's grouping config: no smoothing, max_gap_s 0, no minimum duration/confidence).
   * A window joins the current event while start - (latest end of the event's windows) <= 0.
   *
   * @param {import('./types').WindowPrediction[]} predictions - chronological
   * @param {import('./types').PcmData} [pcmData] - unused; kept for the previous signature
   * @returns {import('./types').DecodedEvent[]}
   */
  // eslint-disable-next-line no-unused-vars
  decodeEvents(predictions, pcmData) {
    const inhaleWins = predictions.filter((p) => p.predictedClass === INHALE_CLASS);
    if (inhaleWins.length === 0) return [];

    const events = [];
    let current = [inhaleWins[0]];
    let currentEnd = inhaleWins[0].endTime;
    for (const win of inhaleWins.slice(1)) {
      if (win.startTime - currentEnd <= 0.0) {
        current.push(win);
        currentEnd = Math.max(currentEnd, win.endTime);
      } else {
        events.push(this._finalizeEvent(current, events.length));
        current = [win];
        currentEnd = win.endTime;
      }
    }
    events.push(this._finalizeEvent(current, events.length));
    return events;
  }

  /**
   * Build one decoded event from its grouped Inhale windows (InhaleEvent in post_event):
   * start = min window start, end = max window end, confidence = mean / max P(Inhale).
   * @private
   */
  _finalizeEvent(wins, eventId) {
    let start = Infinity;
    let end = -Infinity;
    let sumProb = 0;
    let maxProb = -Infinity;
    for (const win of wins) {
      start = Math.min(start, win.startTime);
      end = Math.max(end, win.endTime);
      const prob = win.probabilities[INHALE_CLASS];
      sumProb += prob;
      if (prob > maxProb) maxProb = prob;
    }
    return {
      eventId,
      startS: start,
      endS: end,
      durationS: end - start,
      detectorConfidence: sumProb / wins.length,
      detectorMaxConfidence: maxProb,
      windowCount: wins.length,
      windowIndices: wins.map((w) => w.windowIndex),
      windowPredictions: wins,
    };
  }

  /**
   * Stages 9-12: measure one event, apply the usability rule and score it.
   *
   * @param {import('./types').DecodedEvent} event
   * @param {import('./types').DecodedEvent[]} allEvents - chronological, as decoded
   * @param {import('./types').PcmData} pcmData
   * @returns {Promise<Object>} the canonical event object (EVENT_KEYS order)
   */
  async processEvent(event, allEvents, pcmData) {
    const eventPcm = this.extractEventPcm(event, pcmData);
    // An event that does not overlap the audio cannot be measured (analyze_inhalation raises).
    const features = eventPcm.length > 0 ? await this.extractEventFeatures(eventPcm) : null;
    const scoreability = this.checkScoreability(event, allEvents, pcmData, features);
    const scoring = scoreability.isScoreable ? await this.scoreEvent(features) : null;
    return this._eventOutput(event, features, scoreability.reasons, scoring);
  }

  /**
   * Stage 9: the event's raw PCM segment, waveform[floor(start * sr) : ceil(end * sr)].
   *
   * @param {import('./types').DecodedEvent} event
   * @param {import('./types').PcmData} pcmData
   * @returns {Float32Array} a view on the event samples
   */
  extractEventPcm(event, pcmData) {
    const sr = pcmData.sampleRate;
    const startIdx = Math.max(0, Math.floor(event.startS * sr));
    const endIdx = Math.min(pcmData.samples.length, Math.ceil(event.endS * sr));
    if (startIdx >= endIdx) return new Float32Array(0);
    return pcmData.samples.subarray(startIdx, endIdx);
  }

  /**
   * Stage 10: V2 event features and mean_rms of an event segment.
   *
   * @param {Float32Array} eventPcm
   * @returns {Promise<import('./types').EventFeatures>}
   */
  async extractEventFeatures(eventPcm) {
    if (!this._featureExtractor) this._featureExtractor = new FeatureExtractor();
    return this._featureExtractor.extractFeatures(eventPcm);
  }

  /**
   * Stage 7 (scoreability): Stage 1 usability rule v1, as prism_inference.not_scoreable_reasons.
   * Reasons are listed in the contract's order. Durations and neighbour gaps are rounded to
   * 6 decimals (numpy.round, ties to even) before comparison; boundary times are not rounded.
   *
   * @param {import('./types').DecodedEvent} event
   * @param {import('./types').DecodedEvent[]} allEvents - chronological
   * @param {import('./types').PcmData} pcmData
   * @param {import('./types').EventFeatures|null} features - null if measurement failed
   * @returns {import('./types').EventScoreability}
   */
  checkScoreability(event, allEvents, pcmData, features) {
    const finite = features != null
      && Array.from(features.features).every(Number.isFinite)
      && Number.isFinite(features.mean_rms);

    const i = allEvents.indexOf(event) >= 0
      ? allEvents.indexOf(event)
      : allEvents.findIndex((e) => e.eventId === event.eventId);
    const gaps = [];
    if (i > 0) gaps.push(roundHalfEven(event.startS - allEvents[i - 1].endS, TIME_DECIMALS));
    if (i >= 0 && i + 1 < allEvents.length) gaps.push(roundHalfEven(allEvents[i + 1].startS - event.endS, TIME_DECIMALS));

    const recordingDuration = pcmData.samples.length / pcmData.sampleRate;
    const margin = SCOREABILITY_CONFIG.boundaryMarginS;
    const flags = {
      [NOT_SCOREABLE_REASONS.NONFINITE_FEATURE]: !finite,
      [NOT_SCOREABLE_REASONS.SHORT_DURATION]:
        roundHalfEven(event.durationS, TIME_DECIMALS) < SCOREABILITY_CONFIG.minDurationS,
      [NOT_SCOREABLE_REASONS.CLOSE_NEIGHBOR]: gaps.length > 0 && Math.min(...gaps) < SCOREABILITY_CONFIG.minGapS,
      [NOT_SCOREABLE_REASONS.RECORDING_BOUNDARY]:
        event.startS <= margin || event.endS >= recordingDuration - margin,
    };
    const reasons = Object.values(NOT_SCOREABLE_REASONS).filter((r) => flags[r]);
    return { isScoreable: reasons.length === 0, reasons };
  }

  /**
   * Stage 12: robust z against the frozen baseline (float64) and anomaly_score = sqrt(mean z²).
   *
   * @param {import('./types').EventFeatures} features
   * @returns {Promise<{ anomalyScore: number, featureZScores: Float64Array }>} in V2 order
   */
  async scoreEvent(features) {
    const baseline = await this._getBaseline();
    if (features.version !== undefined && features.version !== baseline.featureSchemaVersion) {
      throw new Error(`features were computed for ${features.version}, baseline is ${baseline.featureSchemaVersion}`);
    }
    const zScores = new Float64Array(V2_FEATURE_ORDER.length);
    for (let i = 0; i < zScores.length; i++) {
      zScores[i] = (features.features[i] - baseline.centers[i]) / baseline.scales[i];
    }
    return { anomalyScore: rmsZ(zScores), featureZScores: zScores };
  }

  // ─── Canonical event object ────────────────────────────────────────────────

  /**
   * prism_inference._event_output: plain JSON numbers, named objects in V2 order.
   * feature_values are reported whenever all four are finite (also for NOT_SCOREABLE events);
   * z-scores and anomaly_score only for SCORE_ONLY events.
   * @private
   */
  _eventOutput(event, features, reasons, scoring) {
    const values = features ? Array.from(features.features) : null;
    const valuesFinite = values !== null && values.every(Number.isFinite);
    const meanRms = features && Number.isFinite(features.mean_rms) ? features.mean_rms : null;
    const named = (arr) => Object.fromEntries(V2_FEATURE_ORDER.map((f, i) => [f, arr[i]]));
    const scored = reasons.length === 0;
    return {
      event_id: event.eventId,
      start_time: event.startS,
      end_time: event.endS,
      duration_s: event.durationS,
      detector_confidence: event.detectorConfidence,
      detector_max_confidence: event.detectorMaxConfidence,
      window_count: event.windowCount,
      status: scored ? EVENT_STATUS.SCORE_ONLY : EVENT_STATUS.NOT_SCOREABLE,
      not_scoreable_reasons: [...reasons],
      anomaly_score: scored ? scoring.anomalyScore : null,
      feature_values: valuesFinite ? named(values) : null,
      feature_z_scores: scored ? named(Array.from(scoring.featureZScores)) : null,
      mean_rms: meanRms,
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** @private */
  _requireDetector() {
    if (!this._detector) {
      throw new Error(
        "InferencePipeline has no detector: create it with createNodePipeline() (pipeline/runtime/node.js) " +
        "or createReactNativePipeline() (pipeline/runtime/reactNative.js)"
      );
    }
    return this._detector;
  }

  /** @private */
  async _getBaseline() {
    if (!this._baseline) {
      const store = new BaselineStore();
      this._baseline = await store.loadBaseline(this._baselineJson);
    }
    return this._baseline;
  }

  /** @private */
  _allFinite(frameFeatures) {
    for (const frame of frameFeatures) {
      for (let i = 0; i < frame.features.length; i++) {
        if (!Number.isFinite(frame.features[i])) return false;
      }
    }
    return true;
  }
}
