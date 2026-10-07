import SessionAggregator from './SessionAggregator.js';
import { canonicalOutput } from './test_fixtures.js';

function test() {
    console.log("Starting Stage 13 Session Aggregation Test");
    
    const aggregator = new SessionAggregator();
    
    // Canonical recording outputs (inference_output.schema.json), as run() returns them
    const rec1 = canonicalOutput("rec_001", "2026-10-01T12:00:00Z", [
        { start: 1.5, end: 1.7, reasons: ["short_duration"] },
        { start: 4.5, score: 1.2 },
    ]);
    const rec2 = canonicalOutput("rec_002", "2026-10-01T12:01:00Z", [{ start: 2.0, score: 0.8 }]);
    const rec3Error = canonicalOutput("rec_003", "2026-10-01T12:02:00Z", [], "invalid_shape");

    const session = aggregator.aggregate("sess_123", [rec1, rec2, rec3Error]);
    
    const summary = session.diagnostics.anomaly_score_summary;
    console.log(`Session ID: ${session.session_id}`);
    console.log(`Session Status: ${session.session_status}`);
    console.log(`Total Events: ${session.n_events}`);
    console.log(`Total Scored: ${session.n_scored}`);
    console.log(`Diagnostic score summary (internal): ${JSON.stringify(summary)}`);
    
    if (session.session_status !== 'INPUT_ERROR') throw new Error("Status should indicate an input error exists");
    if (session.input_errors.length !== 1 || session.input_errors[0].error !== 'invalid_shape'
        || session.input_errors[0].recording_id !== 'rec_003') throw new Error("Input error not reported");
    if (session.n_events !== 3) throw new Error("Event count mismatch");
    if (session.n_scored !== 2) throw new Error("Scored count mismatch");
    if (session.n_not_scoreable !== 1) throw new Error("Not-scoreable count mismatch");
    if (summary.min !== 0.8) throw new Error("Min score mismatch");
    if (summary.max !== 1.2) throw new Error("Max score mismatch");
    if (summary.mean !== 1.0) throw new Error("Mean score mismatch");
    if (session.events.length !== 3) throw new Error("Events array length mismatch");
    if (session.recorded_at !== "2026-10-01T12:00:00.000Z") throw new Error("Session time must be the earliest recorded_at");
    const order = session.events.map((e) => `${e.recording_id}#${e.event_id}`).join(",");
    if (order !== "rec_001#0,rec_001#1,rec_002#0") throw new Error(`Events not chronological: ${order}`);
    if (session.recordings.length !== 3 || session.recordings[0] !== rec1) throw new Error("Canonical outputs must be kept verbatim");
    if (JSON.stringify(JSON.parse(JSON.stringify(session))) !== JSON.stringify(session)) throw new Error("Session is not plain JSON");
    
    console.log("SUCCESS: Session aggregation correctly pools multiple recordings.");
}

test();
