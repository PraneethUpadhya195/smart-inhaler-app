import fs from 'fs';

/**
 * Stage 11: Versioned Baseline Infrastructure
 * Handles loading, validating, and retrieving clinical feature baselines.
 */
export default class BaselineStore {
    constructor(fallbackPath = 'assets/ml/v2_validation/v2_baseline.json') {
        this.fallbackPath = fallbackPath;
        this.baselines = new Map();
    }

    /**
     * Load a baseline from a JSON string or file path
     * @param {string} [pathOrData] If provided, loads from this. Otherwise uses fallbackPath.
     * @param {boolean} [isData=false] If true, treats pathOrData as JSON string.
     */
    async loadBaseline(pathOrData = null, isData = false) {
        let content = '{}';
        
        if (isData && pathOrData) {
            content = pathOrData;
        } else {
            const targetPath = pathOrData || this.fallbackPath;
            if (typeof process !== 'undefined' && fs.readFileSync) {
                content = fs.readFileSync(targetPath, 'utf8');
            } else {
                throw new Error("Cannot load baseline file in this environment. Provide JSON data directly.");
            }
        }

        const raw = JSON.parse(content);
        
        // Validate against expected schema
        if (!raw.baseline_id || !raw.contract_version || !raw.features || !raw.parameters) {
            throw new Error("Invalid baseline schema: missing required fields");
        }

        // Normalize into memory format
        const baseline = {
            baselineId: raw.baseline_id,
            featureSchemaVersion: raw.contract_version,
            featureNames: raw.features,
            centers: new Float64Array(raw.features.length),
            scales: new Float64Array(raw.features.length), // usually MAD * 1.4826
            mads: new Float64Array(raw.features.length),
            sampleCount: raw.n_events || 0,
            sessionCount: raw.n_sessions || 0,
            metadata: raw.source || {}
        };

        for (let i = 0; i < raw.features.length; i++) {
            const featName = raw.features[i];
            const params = raw.parameters[featName];
            if (!params) throw new Error(`Missing parameters for feature: ${featName}`);
            
            baseline.centers[i] = params.center;
            baseline.mads[i] = params.mad;
            baseline.scales[i] = params.scale;
        }

        this.baselines.set(baseline.baselineId, baseline);
        // Also index by contract_version if we only have one per version for now
        this.baselines.set(baseline.featureSchemaVersion, baseline);
        
        return baseline;
    }

    /**
     * Get a loaded baseline by ID or Schema Version
     * @param {string} versionOrId 
     * @returns {Object} Normalized baseline object
     */
    getBaseline(versionOrId) {
        const bl = this.baselines.get(versionOrId);
        if (!bl) {
            throw new Error(`Baseline not found for ID/Version: ${versionOrId}`);
        }
        return bl;
    }
}
