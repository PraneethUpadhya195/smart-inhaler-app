import SessionAggregator from './SessionAggregator.js';

function test() {
    console.log("Starting Stage 13 Session Aggregation Test");
    
    const aggregator = new SessionAggregator();
    
    // Create dummy recording results
    const rec1 = {
        input: { recording_id: "rec_001", recorded_at: "2026-10-01T12:00:00Z" },
        nEvents: 2,
        nScored: 1,
        events: [
            { eventId: 0, startTime: 1.5, status: 'NOT_SCOREABLE', anomalyScore: null },
            { eventId: 1, startTime: 4.5, status: 'SCORE_ONLY', anomalyScore: 1.2 }
        ]
    };
    
    const rec2 = {
        input: { recording_id: "rec_002", recorded_at: "2026-10-01T12:01:00Z" },
        nEvents: 1,
        nScored: 1,
        events: [
            { eventId: 0, startTime: 2.0, status: 'SCORE_ONLY', anomalyScore: 0.8 }
        ]
    };
    
    const rec3Error = {
        input: { recording_id: "rec_003", recorded_at: "2026-10-01T12:02:00Z" },
        error: "invalid_shape",
        nEvents: 0,
        nScored: 0,
        events: []
    };
    
    const session = aggregator.aggregate("sess_123", [rec1, rec2, rec3Error]);
    
    console.log(`Session ID: ${session.sessionId}`);
    console.log(`Session Status: ${session.status}`);
    console.log(`Total Events: ${session.nEvents}`);
    console.log(`Total Scored: ${session.nScored}`);
    console.log(`Aggregate Min Score: ${session.aggregateScores?.min}`);
    console.log(`Aggregate Max Score: ${session.aggregateScores?.max}`);
    console.log(`Aggregate Mean Score: ${session.aggregateScores?.mean}`);
    
    if (session.status !== 'HAS_ERRORS') throw new Error("Status should indicate errors exist");
    if (session.nEvents !== 3) throw new Error("Event count mismatch");
    if (session.nScored !== 2) throw new Error("Scored count mismatch");
    if (session.aggregateScores.min !== 0.8) throw new Error("Min score mismatch");
    if (session.aggregateScores.max !== 1.2) throw new Error("Max score mismatch");
    if (session.aggregateScores.mean !== 1.0) throw new Error("Mean score mismatch");
    if (session.events.length !== 3) throw new Error("Events array length mismatch");
    
    console.log("SUCCESS: Session aggregation correctly pools multiple recordings.");
}

test();
