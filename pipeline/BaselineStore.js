import { ContractError, isClose } from "./contract.js";
import { baselineV2 } from "./contractAssets.js";
import { BASELINE_ID, INFERENCE_CONTRACT_VERSION, MAD_SCALE, V2_FEATURE_ORDER } from "./versions.js";

/**
 * Stage 11: frozen V2 baseline.
 *
 * Loads and validates the global reference baseline (assets/ml/v2_validation/v2_baseline.json:
 * per-feature median and 1.4826 * MAD over the 318 usable reference events). It is loaded,
 * never fitted or updated, at inference (contract baseline.fitting_at_inference = "never").
 *
 * Validation mirrors prism_inference.FrozenBaseline and the contract's baseline.loading rule:
 * contract_version, baseline_id, V2 feature order, finiteness, MAD > 0 and
 * scale = 1.4826 * MAD. A baseline that fails any check is refused.
 *
 * There is no personalization: a different baseline would be a new baseline_id with its own
 * validation (research decision), added here as another entry keyed by its id.
 */
export default class BaselineStore {
    constructor() {
        this.baselines = new Map();
    }

    /**
     * Validate a baseline object against the contract and normalise it.
     * @param {Object} raw - parsed baseline JSON
     * @returns {Object} normalised baseline (frozen)
     * @throws {ContractError}
     */
    static validate(raw) {
        if (raw === null || typeof raw !== "object") throw new ContractError("baseline must be a JSON object");
        if (raw.contract_version !== INFERENCE_CONTRACT_VERSION) {
            throw new ContractError(`baseline was issued for ${raw.contract_version}, not ${INFERENCE_CONTRACT_VERSION}`);
        }
        if (raw.baseline_id !== BASELINE_ID) {
            throw new ContractError(`baseline_id ${raw.baseline_id} is not the contract's ${BASELINE_ID}`);
        }
        const features = raw.features;
        if (!Array.isArray(features) || features.length !== V2_FEATURE_ORDER.length
            || !features.every((f, i) => f === V2_FEATURE_ORDER[i])) {
            throw new ContractError(`baseline features ${JSON.stringify(features)} do not match the V2 order`);
        }
        const parameters = raw.parameters ?? {};
        const keys = Object.keys(parameters);
        if (keys.length !== features.length || !features.every((f) => keys.includes(f))) {
            throw new ContractError("baseline parameters and feature list differ");
        }
        if (raw.mad_scale !== MAD_SCALE) throw new ContractError(`mad_scale must be ${MAD_SCALE}`);

        const centers = features.map((f) => parameters[f].center);
        const mads = features.map((f) => parameters[f].mad);
        const scales = features.map((f) => parameters[f].scale);
        for (const [name, values] of [["center", centers], ["mad", mads], ["scale", scales]]) {
            if (!values.every((v) => typeof v === "number" && Number.isFinite(v))) {
                throw new ContractError(`baseline ${name} must hold ${features.length} finite values`);
            }
        }
        if (!mads.every((v) => v > 0)) throw new ContractError("every baseline MAD must be > 0");
        mads.forEach((mad, i) => {
            if (!isClose(scales[i], raw.mad_scale * mad, { relTol: 1e-12, absTol: 0 })) {
                throw new ContractError("baseline scale must equal mad_scale * MAD");
            }
        });
        if (!Number.isInteger(raw.n_events) || !Number.isInteger(raw.n_sessions)) {
            throw new ContractError("baseline n_events and n_sessions must be integers");
        }

        return Object.freeze({
            baselineId: raw.baseline_id,
            featureSchemaVersion: raw.contract_version,
            featureNames: Object.freeze([...features]),
            centers: Float64Array.from(centers),
            scales: Float64Array.from(scales),
            mads: Float64Array.from(mads),
            madScale: raw.mad_scale,
            sampleCount: raw.n_events,
            sessionCount: raw.n_sessions,
            metadata: raw.source ?? {},
        });
    }

    /**
     * Load and validate a baseline.
     * @param {Object|string} [source] - parsed baseline object (default: the bundled V2 baseline),
     *   or its JSON text when isData is true. File paths are not supported: the pipeline must not
     *   depend on Node's fs (React Native); pass the parsed JSON instead.
     * @param {boolean} [isData=false] - treat a string source as JSON text
     * @returns {Promise<Object>} normalised baseline
     */
    async loadBaseline(source = baselineV2, isData = false) {
        let raw = source;
        if (typeof source === "string") {
            if (!isData) {
                throw new Error("BaselineStore.loadBaseline: file paths are not supported; pass the parsed baseline JSON");
            }
            raw = JSON.parse(source);
        }
        const baseline = BaselineStore.validate(raw);
        this.baselines.set(baseline.baselineId, baseline);
        // Also indexed by contract version: there is exactly one baseline per contract version.
        this.baselines.set(baseline.featureSchemaVersion, baseline);
        return baseline;
    }

    /**
     * Get a loaded baseline by ID or contract version.
     * @param {string} versionOrId
     * @returns {Object} normalised baseline
     */
    getBaseline(versionOrId) {
        const bl = this.baselines.get(versionOrId);
        if (!bl) {
            throw new Error(`Baseline not found for ID/Version: ${versionOrId}`);
        }
        return bl;
    }
}
