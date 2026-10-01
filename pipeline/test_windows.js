import InferencePipeline from './InferencePipeline.js';

function generateSyntheticFrames(numFrames) {
    const frames = [];
    for (let i = 0; i < numFrames; i++) {
        const features = new Float32Array(124);
        // Fill with a unique value identifying the frame
        features.fill(i);
        frames.push({
            frameIndex: i,
            features: features,
            timestamp: i * (64.0 / 8000.0) // hop length 64, sr 8000
        });
    }
    return frames;
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(`Assertion failed: ${message}`);
    }
}

function test() {
    const pipeline = new InferencePipeline();
    
    console.log("Test 1: Normal processing (30 frames)");
    // 30 frames: window=25, stride=2 -> (30-25)/2 + 1 = Math.floor(5/2) + 1 = 3 windows
    let frames = generateSyntheticFrames(30);
    let windows = pipeline.buildWindows(frames);
    
    assert(windows.length === 3, `Expected 3 windows, got ${windows.length}`);
    
    // Window 0 check
    assert(windows[0].windowIndex === 0, "Window 0 index mismatch");
    assert(windows[0].tensor[0] === 0, "Window 0 should start with frame 0");
    assert(windows[0].tensor[124] === 1, "Window 0 frame 1 mismatch");
    assert(windows[0].tensor[24 * 124] === 24, "Window 0 should end with frame 24");
    assert(windows[0].startTime === 0, "Window 0 start time mismatch");
    // endTime is frame 24 timestamp + 0.008
    const expectedEnd0 = 24 * 0.008 + 0.008;
    assert(Math.abs(windows[0].endTime - expectedEnd0) < 1e-6, `Window 0 end time mismatch: expected ${expectedEnd0}, got ${windows[0].endTime}`);
    
    // Window 1 check (starts at frame 2)
    assert(windows[1].windowIndex === 1, "Window 1 index mismatch");
    assert(windows[1].tensor[0] === 2, "Window 1 should start with frame 2");
    assert(windows[1].tensor[24 * 124] === 26, "Window 1 should end with frame 26");
    
    // Window 2 check (starts at frame 4)
    assert(windows[2].windowIndex === 2, "Window 2 index mismatch");
    assert(windows[2].tensor[0] === 4, "Window 2 should start with frame 4");
    assert(windows[2].tensor[24 * 124] === 28, "Window 2 should end with frame 28");
    
    // Total length check
    assert(windows[0].tensor.length === 3100, "Window tensor length should be 3100 (25*124)");
    
    console.log("Test 2: Insufficient frames (24 frames)");
    frames = generateSyntheticFrames(24);
    windows = pipeline.buildWindows(frames);
    assert(windows.length === 0, `Expected 0 windows, got ${windows.length}`);
    
    console.log("Test 3: Exactly 25 frames");
    frames = generateSyntheticFrames(25);
    windows = pipeline.buildWindows(frames);
    assert(windows.length === 1, `Expected 1 window, got ${windows.length}`);
    assert(windows[0].tensor[0] === 0, "Starts with 0");
    assert(windows[0].tensor[24 * 124] === 24, "Ends with 24");
    
    console.log("All tests passed!");
}

test();
