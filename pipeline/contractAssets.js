/**
 * pipeline/contractAssets.js
 *
 * The contract's JSON artefacts, imported statically so that the same code works in Node
 * (ES modules with import attributes) and in React Native (Metro bundles the JSON).
 * No `fs` and no working-directory-relative paths are involved.
 *
 * The files under assets/ml/ are copies of the research outputs and must not be edited
 * (CLAUDE.md §2); only the ONNX model is loaded separately, as bytes, by the platform runtime.
 */

import baselineV2 from "../assets/ml/v2_validation/v2_baseline.json" with { type: "json" };
import featureSchemaV2 from "../assets/ml/v2_validation/v2_feature_schema.json" with { type: "json" };
import inferenceContractV2 from "../assets/ml/v2_validation/inference_contract_v2.json" with { type: "json" };
// Stage 9 final assessment (prism-assessment-v1.0) and the V3 personal-reference draft (Stage 10).
import assessmentReferenceV1 from "../assets/ml/final_assessment/assessment_reference_v1.json" with { type: "json" };
import personalContractV3 from "../assets/ml/personal_reference/personal_contract_v3.json" with { type: "json" };

export { baselineV2, featureSchemaV2, inferenceContractV2, assessmentReferenceV1, personalContractV3 };
