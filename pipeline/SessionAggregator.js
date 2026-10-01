/**
 * Stage 13: Session Aggregation
 * Aggregates one or more recording results (which may contain multiple events)
 * into a single unified session payload.
 */
export default class SessionAggregator {
    /**
     * Group multiple recording results into a single session.
     * @param {string} sessionId
     * @param {Object[]} recordingResults Array of RecordingResult objects from InferencePipeline
     * @returns {Object} Aggregated session metadata
     */
    aggregate(sessionId, recordingResults) {
        let totalEvents = 0;
        let totalScored = 0;
        const allEvents = [];
        const errors = [];
        
        let minScore = null;
        let maxScore = null;
        let sumScore = 0;
        
        let firstTimestamp = null;
        
        for (const rec of recordingResults) {
            if (!firstTimestamp && rec.input && rec.input.recorded_at) {
                firstTimestamp = rec.input.recorded_at;
            }
            
            if (rec.error) {
                errors.push({
                    recordingId: rec.input?.recording_id,
                    error: rec.error
                });
            }
            
            totalEvents += rec.nEvents || 0;
            totalScored += rec.nScored || 0;
            
            if (rec.events) {
                for (const ev of rec.events) {
                    // Enrich event with recording context
                    const sessionEvent = {
                        recordingId: rec.input?.recording_id,
                        recordedAt: rec.input?.recorded_at,
                        ...ev
                    };
                    allEvents.push(sessionEvent);
                    
                    if (ev.status === 'SCORE_ONLY' && ev.anomalyScore !== null) {
                        if (minScore === null || ev.anomalyScore < minScore) minScore = ev.anomalyScore;
                        if (maxScore === null || ev.anomalyScore > maxScore) maxScore = ev.anomalyScore;
                        sumScore += ev.anomalyScore;
                    }
                }
            }
        }
        
        // Sort chronologically
        allEvents.sort((a, b) => {
            const timeA = (a.recordedAt ? new Date(a.recordedAt).getTime() : 0) + (a.startTime * 1000);
            const timeB = (b.recordedAt ? new Date(b.recordedAt).getTime() : 0) + (b.startTime * 1000);
            return timeA - timeB;
        });
        
        let sessionStatus = 'NO_INHALATIONS';
        if (errors.length > 0) {
            sessionStatus = 'HAS_ERRORS';
        } else if (totalScored > 0) {
            sessionStatus = 'SCORED';
        } else if (totalEvents > 0) {
            sessionStatus = 'EVENTS_DETECTED_NOT_SCOREABLE';
        }
        
        return {
            sessionId,
            sessionTimestamp: firstTimestamp || new Date().toISOString(),
            status: sessionStatus,
            nEvents: totalEvents,
            nScored: totalScored,
            aggregateScores: totalScored > 0 ? {
                min: minScore,
                max: maxScore,
                mean: sumScore / totalScored
            } : null,
            events: allEvents,
            errors: errors.length > 0 ? errors : null
        };
    }
}
