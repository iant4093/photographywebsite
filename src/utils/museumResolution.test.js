import { describe, expect, it } from 'vitest'
import { createMuseumResolutionController, museumResolutionProfile } from './museumResolution'

const phone = { touchMode: true, width: 393, height: 852, devicePixelRatio: 3 }

function simulator(profile = museumResolutionProfile(phone)) {
    const controller = createMuseumResolutionController(profile)
    let now = 0
    const changes = []
    controller.sample(now)
    return {
        controller,
        changes,
        frame(delta, enabled = true) {
            now += delta
            const dpr = controller.sample(now, enabled)
            if (dpr !== null) changes.push({ now, dpr })
            return dpr
        },
        run(duration, delta = 1000 / 60, enabled = true) {
            for (let elapsed = 0; elapsed < duration; elapsed += delta) this.frame(delta, enabled)
        },
    }
}

describe('museum resolution profiles', () => {
    it('starts phones at a sharper resolution with a bounded adaptive range and antialiasing', () => {
        expect(museumResolutionProfile(phone)).toEqual({
            initialDpr: 1.5, minDpr: 1, maxDpr: 1.75, antialias: true,
        })
    })

    it.each([1, 1.25, 1.5])('never exceeds a native device pixel ratio of %s', (devicePixelRatio) => {
        const profile = museumResolutionProfile({ ...phone, devicePixelRatio })
        expect(profile.maxDpr).toBe(devicePixelRatio)
        expect(profile.initialDpr).toBeLessThanOrEqual(devicePixelRatio)
        expect(profile.minDpr).toBeLessThanOrEqual(profile.initialDpr)
    })

    it.each([
        [4, 1.25, 1.5],
        [2, 1.25, 1.5],
        [8, 1.5, 1.75],
    ])('uses a conservative starting point on a %s GB device', (deviceMemory, initialDpr, maxDpr) => {
        expect(museumResolutionProfile({ ...phone, deviceMemory })).toMatchObject({ initialDpr, maxDpr })
    })

    it.each([
        [undefined, 1_100_000],
        [4, 1_100_000],
        [2, 800_000],
    ])('bounds large tablet drawing buffers with %s GB memory', (deviceMemory, budget) => {
        const width = 1366
        const height = 1024
        const profile = museumResolutionProfile({ ...phone, width, height, deviceMemory })
        expect(profile.maxDpr).toBeLessThan(1)
        expect(profile.initialDpr).toBe(profile.maxDpr)
        expect(profile.minDpr).toBe(profile.maxDpr)
        expect(width * height * profile.maxDpr ** 2).toBeCloseTo(budget, 5)
    })

    it('applies the smaller memory budget to larger phones as well', () => {
        const width = 430
        const height = 932
        const profile = museumResolutionProfile({ ...phone, width, height, deviceMemory: 2 })
        expect(width * height * profile.maxDpr ** 2).toBeCloseTo(800_000, 5)
        expect(profile.initialDpr).toBe(1.25)
    })

    it('keeps desktop resolution and the Firefox antialiasing exception unchanged', () => {
        expect(museumResolutionProfile({})).toEqual({
            initialDpr: 0.8, minDpr: 0.8, maxDpr: 0.8, antialias: true,
        })
        expect(museumResolutionProfile({ firefox: true, windowsFirefox: true })).toEqual({
            initialDpr: 0.68, minDpr: 0.68, maxDpr: 0.68, antialias: false,
        })
        expect(museumResolutionProfile({ ...phone, firefox: true }).antialias).toBe(false)
    })

    it.each([undefined, null, NaN, Infinity, -Infinity, 0, -20, '3'])(
        'handles invalid dimensions and device hints (%s) with finite, ordered bounds', (value) => {
            const profile = museumResolutionProfile({
                touchMode: true, width: value, height: value, devicePixelRatio: value, deviceMemory: value,
            })
            expect(Number.isFinite(profile.initialDpr)).toBe(true)
            expect(profile.minDpr).toBeGreaterThan(0)
            expect(profile.minDpr).toBeLessThanOrEqual(profile.initialDpr)
            expect(profile.initialDpr).toBeLessThanOrEqual(profile.maxDpr)
            expect(profile.maxDpr).toBeLessThanOrEqual(1)
        },
    )

    it('remains finite for extreme dimensions and omitted options', () => {
        const profile = museumResolutionProfile({ ...phone, width: Number.MAX_VALUE, height: Number.MAX_VALUE })
        expect(Number.isFinite(profile.maxDpr)).toBe(true)
        expect(profile.maxDpr).toBeGreaterThan(0)
        expect(museumResolutionProfile()).toEqual(museumResolutionProfile(null))
    })
})

describe('museum adaptive resolution', () => {
    it('ignores startup work, then reduces resolution when 20 fps persists for a full window', () => {
        const sim = simulator()
        sim.run(3_900, 50)
        expect(sim.changes).toHaveLength(0)
        sim.run(200, 50)
        expect(sim.changes).toHaveLength(1)
        expect(sim.changes[0].dpr).toBeCloseTo(1.35)
        expect(sim.changes[0].now).toBeGreaterThanOrEqual(4_000)
    })

    it('waits for three healthy windows before raising resolution at 60 fps', () => {
        const sim = simulator()
        sim.run(7_900)
        expect(sim.changes).toHaveLength(0)
        sim.run(250)
        expect(sim.changes).toHaveLength(1)
        expect(sim.changes[0].dpr).toBeCloseTo(1.65)
        expect(sim.changes[0].now).toBeGreaterThanOrEqual(8_000)
    })

    it('uses real 100 ms frame times instead of the movement delta clamp', () => {
        const sim = simulator()
        sim.run(4_000, 100)
        expect(sim.changes.map(change => change.dpr)).toEqual([1.35])
        sim.run(20_000, 100)
        expect(sim.controller.snapshot().dpr).toBe(1)
        expect(sim.changes.every(change => change.dpr >= 1)).toBe(true)
        sim.changes.slice(1).forEach((change, index) => {
            expect(change.now - sim.changes[index].now).toBeGreaterThanOrEqual(4_000)
        })
    })

    it('responds to sustained 45 ms load while waiting for enough measured frames', () => {
        const sim = simulator()
        sim.run(4_200, 45)
        expect(sim.changes).toHaveLength(1)
        expect(sim.controller.snapshot().dpr).toBeCloseTo(1.35)

        const verySlow = simulator()
        verySlow.run(5_800, 200)
        expect(verySlow.changes).toHaveLength(0)
        expect(verySlow.controller.snapshot().frames).toBe(19)
        verySlow.frame(200)
        expect(verySlow.changes).toHaveLength(1)
    })

    it('lowers resolution during continuous extreme overload instead of restarting warmup forever', () => {
        const sim = simulator()
        sim.run(7_800, 300)
        expect(sim.changes).toHaveLength(0)
        expect(sim.controller.snapshot().frames).toBe(19)
        sim.frame(300)
        expect(sim.changes).toHaveLength(1)
        expect(sim.controller.snapshot().dpr).toBeCloseTo(1.35)
    })

    it('does not lower quality for isolated loading hitches, even when they raise the average', () => {
        const sim = simulator()
        for (let frame = 0; frame < 900; frame += 1) {
            sim.frame(frame % 10 === 0 ? 240 : 1000 / 60)
        }
        expect(sim.changes).toHaveLength(0)
        expect(sim.controller.snapshot().dpr).toBe(1.5)
    })

    it('keeps sparse hitches from preventing recovery on an otherwise healthy device', () => {
        const sim = simulator()
        for (let frame = 0; frame < 1200; frame += 1) {
            sim.frame(frame % 120 === 0 ? 100 : 1000 / 60)
        }
        expect(sim.controller.snapshot().dpr).toBe(1.75)
        expect(sim.changes.every(change => change.dpr >= 1.5)).toBe(true)
    })

    it('caps 120 fps upgrades at the profile maximum and waits after buffer changes', () => {
        const sim = simulator()
        sim.run(50_000, 1000 / 120)
        expect(sim.changes.map(change => change.dpr)).toEqual([1.65, 1.75])
        expect(sim.changes[1].now - sim.changes[0].now).toBeGreaterThanOrEqual(8_000)
        expect(sim.controller.snapshot().dpr).toBe(1.75)
    })

    it('discards pause and hidden-tab samples, then warms up without resetting visual quality', () => {
        const sim = simulator()
        sim.run(4_100, 50)
        expect(sim.controller.snapshot().dpr).toBeCloseTo(1.35)
        sim.run(20_000, 100, false)
        expect(sim.controller.snapshot().frames).toBe(0)
        sim.run(3_900, 50)
        expect(sim.changes).toHaveLength(1)
        sim.run(300, 50)
        expect(sim.changes).toHaveLength(2)
        expect(sim.controller.snapshot().dpr).toBeCloseTo(1.2)
    })

    it('treats a long RAF gap as a fresh window instead of GPU load', () => {
        const sim = simulator()
        sim.run(3_900, 50)
        sim.frame(15_000)
        sim.run(3_900, 50)
        expect(sim.changes).toHaveLength(0)
        sim.run(200, 50)
        expect(sim.changes).toHaveLength(1)
    })

    it('requires another healthy streak after an unsettled window', () => {
        const sim = simulator()
        sim.run(6_100)
        expect(sim.controller.snapshot().healthyWindows).toBe(2)
        sim.run(2_100, 1000 / 45)
        expect(sim.controller.snapshot().healthyWindows).toBe(0)
        sim.run(3_900)
        expect(sim.changes).toHaveLength(0)
        sim.run(2_400)
        expect(sim.changes).toHaveLength(1)
    })

    it('keeps quality unchanged while frame time stays between upgrade and downgrade thresholds', () => {
        const sim = simulator()
        sim.run(30_000, 1000 / 45)
        expect(sim.changes).toHaveLength(0)
    })

    it('preserves image clarity when a mobile power-saving mode caps RAF at 30 fps', () => {
        const sim = simulator()
        sim.run(60_000, 1000 / 30)
        expect(sim.changes).toHaveLength(0)
        expect(sim.controller.snapshot().dpr).toBe(1.5)
    })

    it('preserves fixed desktop and pixel-limited tablet bounds under both fast and slow rendering', () => {
        for (const profile of [
            museumResolutionProfile(),
            museumResolutionProfile({ ...phone, width: 1366, height: 1024 }),
        ]) {
            const sim = simulator(profile)
            sim.run(20_000, 100)
            sim.run(30_000, 1000 / 120)
            expect(sim.changes).toHaveLength(0)
            expect(sim.controller.snapshot().dpr).toBe(profile.initialDpr)
        }
    })

    it('reset clears pending measurements but preserves the current drawing-buffer resolution', () => {
        const sim = simulator()
        sim.run(4_100, 100)
        const previousDpr = sim.controller.snapshot().dpr
        sim.controller.reset()
        expect(sim.controller.snapshot()).toEqual({
            dpr: previousDpr, frames: 0, elapsedMs: 0, healthyWindows: 0, averageMs: 0, slowFrameRatio: 0,
        })
        sim.run(3_900, 100)
        expect(sim.controller.snapshot().dpr).toBe(previousDpr)
    })

    it('ignores invalid and backwards timestamps safely and returns independent snapshots', () => {
        const controller = createMuseumResolutionController(null)
        for (const timestamp of [undefined, null, NaN, Infinity, -1, 10, 10, 9]) {
            expect(controller.sample(timestamp)).toBeNull()
        }
        const snapshot = controller.snapshot()
        snapshot.dpr = 9
        expect(controller.snapshot().dpr).toBe(0.8)
        expect(Object.values(controller.snapshot()).every(Number.isFinite)).toBe(true)
    })

    it('normalizes a malformed controller profile without allowing inverted bounds', () => {
        const controller = createMuseumResolutionController({ minDpr: 1, initialDpr: 9, maxDpr: 0.5 })
        expect(controller.snapshot().dpr).toBe(1)
    })
})
