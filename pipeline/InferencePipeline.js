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
    // TODO: Stage 3 — Mobile DSP Engine
    throw new Error("extractFrameFeatures() not yet implemented (Stage 3).");
  }

  /**
   * Stage 5: Build [25, 124] sliding windows from frame features.
   *
   * @param {import('./types').FrameFeatures[]} frameFeatures
   * @returns {import('./types').CnnWindow[]}
   */
  buildWindows(frameFeatures) {
    // TODO: Stage 5 — CNN Sliding-Window Builder
    throw new Error("buildWindows() not yet implemented (Stage 5).");
  }

  /**
   * Stage 2/6: Run ONNX model inference on windows.
   *
   * @param {import('./types').CnnWindow[]} windows
   * @returns {Promise<import('./types').WindowPrediction[]>}
   */
  async runInference(windows) {
    // TODO: Stage 2 — ONNX Runtime Smoke Test
    throw new Error("runInference() not yet implemented (Stage 2).");
  }

  /**
   * Stage 8: Decode window predictions into inhalation event intervals.
   *
   * @param {import('./types').WindowPrediction[]} predictions
   * @param {import('./types').PcmData} pcmData
   * @returns {import('./types').DecodedEvent[]}
   */
  decodeEvents(predictions, pcmData) {
    // TODO: Stage 8 — Temporal Event Decoder
    throw new Error("decodeEvents() not yet implemented (Stage 8).");
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
    // TODO: Stage 9 — Whole Inhale Event Extraction
    throw new Error("extractEventPcm() not yet implemented (Stage 9).");
  }

  /**
   * Stage 10: Extract V2 event-level features from event PCM.
   *
   * @param {Float32Array} eventPcm
   * @returns {Promise<import('./types').EventFeatures>}
   */
  async extractEventFeatures(eventPcm) {
    // TODO: Stage 10 — Versioned Event-Feature Engine
    throw new Error("extractEventFeatures() not yet implemented (Stage 10).");
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
