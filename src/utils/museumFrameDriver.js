const DEFAULT_SETTLE_DELTA = 1 / 60

export function createMuseumFrameDriver({
    requestFrame,
    cancelFrame,
    advance,
    isVisible = () => true,
    initialTime = 0,
    maximumDelta = 0.05,
} = {}) {
    if (typeof requestFrame !== 'function' || typeof cancelFrame !== 'function' || typeof advance !== 'function') {
        throw new TypeError('Museum frame driver requires requestFrame, cancelFrame, and advance functions')
    }

    let frameId = 0
    let pendingFrames = 0
    let continuous = false
    let destroyed = false
    let lastWallTime = null
    let logicalTime = Number.isFinite(initialTime) ? initialTime : 0

    const schedule = () => {
        if (destroyed || frameId || !isVisible()) return
        frameId = requestFrame(tick)
    }

    function tick(wallTime) {
        frameId = 0
        if (destroyed || !isVisible()) {
            lastWallTime = null
            return
        }
        const rawDelta = lastWallTime === null
            ? DEFAULT_SETTLE_DELTA
            : Math.max(0, (Number(wallTime) - lastWallTime) / 1000)
        const delta = Math.min(maximumDelta, Number.isFinite(rawDelta) ? rawDelta : DEFAULT_SETTLE_DELTA)
        lastWallTime = Number.isFinite(Number(wallTime)) ? Number(wallTime) : lastWallTime
        logicalTime += delta
        pendingFrames = Math.max(0, pendingFrames - 1)
        advance(logicalTime)
        if (continuous || pendingFrames > 0) schedule()
    }

    const request = (frames = 1) => {
        if (destroyed) return
        pendingFrames = Math.max(pendingFrames, Math.max(1, Math.floor(Number(frames) || 1)))
        schedule()
    }

    const suspend = () => {
        if (frameId) cancelFrame(frameId)
        frameId = 0
        lastWallTime = null
    }

    const resume = (settleFrames = 3) => {
        // Browsers may silently discard the callback that was pending before a
        // tab or window was occluded. Forget that handle unconditionally and
        // request a brand-new callback instead of trusting its old identity.
        suspend()
        request(settleFrames)
    }

    const setContinuous = (value) => {
        continuous = Boolean(value)
        if (continuous) request()
    }

    const destroy = () => {
        destroyed = true
        suspend()
        pendingFrames = 0
    }

    return {
        destroy,
        request,
        resume,
        setContinuous,
        suspend,
        snapshot: () => ({
            continuous,
            frameId,
            logicalTime,
            pendingFrames,
        }),
    }
}
