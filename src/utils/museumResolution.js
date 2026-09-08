const WARMUP_MS = 2_000
const WINDOW_MS = 2_000
const MINIMUM_FRAMES = 20
const MAX_CONTINUOUS_FRAME_MS = 2_000
const RESOLUTION_STEP = 0.15

function positiveNumber(value, fallback) {
    return Number.isFinite(value) && value > 0 ? value : fallback
}

export function museumResolutionProfile(options = {}) {
    const {
        touchMode = false,
        width,
        height,
        devicePixelRatio = 1,
        deviceMemory,
        firefox = false,
        windowsFirefox = false,
    } = options || {}
    const antialias = !firefox
    if (!touchMode) {
        const dpr = windowsFirefox ? 0.68 : 0.8
        return { initialDpr: dpr, minDpr: dpr, maxDpr: dpr, antialias }
    }

    const nativeDpr = positiveNumber(devicePixelRatio, 1)
    const memory = positiveNumber(deviceMemory, Infinity)
    const pixelBudget = memory <= 2 ? 800_000 : 1_100_000
    // Divide before multiplying to remain finite even for malformed, enormous
    // dimensions. A tablet may need a DPR below one to honor this GPU budget.
    const pixelDpr = Math.sqrt(pixelBudget / positiveNumber(width, 390))
        / Math.sqrt(positiveNumber(height, 844))
    const maximum = Math.min(nativeDpr, pixelDpr, memory <= 4 ? 1.5 : 1.75)

    return {
        initialDpr: Math.min(maximum, memory <= 4 ? 1.25 : 1.5),
        minDpr: Math.min(maximum, 1),
        maxDpr: maximum,
        antialias,
    }
}

export function createMuseumResolutionController(profile = {}) {
    const minDpr = positiveNumber(profile?.minDpr, 0.8)
    const maxDpr = Math.max(minDpr, positiveNumber(profile?.maxDpr, minDpr))
    let dpr = Math.min(maxDpr, Math.max(minDpr, positiveNumber(profile?.initialDpr, minDpr)))
    let previousTime = null
    let warmupUntil = null
    let frames = 0
    let elapsedMs = 0
    let slowFrames = 0
    let overloadedFrames = 0
    let healthyWindows = 0

    const clearWindow = () => {
        frames = 0
        elapsedMs = 0
        slowFrames = 0
        overloadedFrames = 0
    }
    const reset = () => {
        previousTime = null
        warmupUntil = null
        healthyWindows = 0
        clearWindow()
    }
    const restartAt = (nowMs) => {
        reset()
        previousTime = nowMs
        warmupUntil = nowMs + WARMUP_MS
    }

    return {
        reset,
        sample(nowMs, enabled = true) {
            if (!enabled || !Number.isFinite(nowMs) || nowMs < 0) {
                reset()
                return null
            }
            if (previousTime === null) {
                restartAt(nowMs)
                return null
            }
            const delta = nowMs - previousTime
            previousTime = nowMs
            if (delta <= 0 || delta > MAX_CONTINUOUS_FRAME_MS) {
                restartAt(nowMs)
                return null
            }
            if (warmupUntil !== null) {
                if (nowMs >= warmupUntil) warmupUntil = null
                return null
            }

            // Use raw RAF timestamps: the movement/animation delta is clamped
            // elsewhere, which would hide genuine sustained rendering load.
            elapsedMs += delta
            frames += 1
            if (delta > 24) slowFrames += 1
            if (delta > 38) overloadedFrames += 1
            if (elapsedMs < WINDOW_MS || frames < MINIMUM_FRAMES) return null

            const averageMs = elapsedMs / frames
            const slowFrameRatio = slowFrames / frames
            let nextDpr = dpr
            // A stable 30 Hz RAF cadence is common in mobile low-power modes.
            // It is playable and does not demonstrate GPU overload, so only
            // sustained work below that floor should sacrifice image clarity.
            if (averageMs > 38 && overloadedFrames / frames > 0.2) {
                healthyWindows = 0
                nextDpr = Math.max(minDpr, dpr - RESOLUTION_STEP)
            } else if (averageMs < 18.5 && slowFrameRatio <= 0.05) {
                healthyWindows += 1
                if (healthyWindows >= 3) {
                    nextDpr = Math.min(maxDpr, dpr + RESOLUTION_STEP)
                    healthyWindows = 0
                }
            } else {
                healthyWindows = 0
            }
            clearWindow()
            if (Math.abs(nextDpr - dpr) < 1e-10) return null
            dpr = nextDpr
            // Let the new drawing buffer settle before judging it. Keeping a
            // longer healthy streak for upgrades avoids repeated oscillation.
            restartAt(nowMs)
            return dpr
        },
        snapshot() {
            return {
                dpr,
                frames,
                elapsedMs,
                healthyWindows,
                averageMs: frames ? elapsedMs / frames : 0,
                slowFrameRatio: frames ? slowFrames / frames : 0,
            }
        },
    }
}
