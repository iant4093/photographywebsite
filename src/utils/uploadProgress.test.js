import { describe, expect, it } from 'vitest'
import { createUploadProgress, formatUploadBytes, formatUploadTime } from './uploadProgress'

describe('upload measurements', () => {
    it('combines concurrent files, includes queued bytes and thumbnails, and counts completion separately', () => {
        let time = 0
        const files = [{ size: 10_000_000 }, { size: 30_000_000 }, { size: 20_000_000 }]
        const tracker = createUploadProgress(files, () => time)
        const first = tracker.progressFor('0:original', files[0])
        const second = tracker.progressFor('1:original', files[1])
        const thumbnail = tracker.progressFor('0:thumbnail', { size: 100_000 })
        expect(tracker.snapshot()).toMatchObject({ totalBytes: 60_100_000, bytesPerSecond: null, remainingSeconds: null })
        first({ loaded: 0 })
        second({ loaded: 0 })
        time = 2000
        first({ loaded: 4_000_000 })
        second({ loaded: 6_000_000 })
        thumbnail({ loaded: 100_000 })
        expect(tracker.snapshot()).toMatchObject({ loadedBytes: 10_100_000, bytesPerSecond: 5_050_000, completedFiles: 0 })
        expect(tracker.snapshot().remainingSeconds).toBeCloseTo(50_000_000 / 5_050_000)
        tracker.completeFile()
        tracker.finalize()
        expect(tracker.snapshot()).toMatchObject({ phase: 'saving', completedFiles: 1, totalFiles: 3 })
    })

    it('rolls back retried file progress while measuring the bytes actually retransmitted', () => {
        let time = 0
        const tracker = createUploadProgress([{ size: 1000 }], () => time)
        const update = tracker.progressFor('0:original', { size: 1000 })
        update({ loaded: 0 })
        time = 1000
        update({ loaded: 800 })
        tracker.snapshot()
        update({ loaded: 0 })
        time = 2000
        update({ loaded: 200 })
        expect(tracker.snapshot()).toMatchObject({ loadedBytes: 200, bytesPerSecond: 500, remainingSeconds: 1.6 })
        update({ loaded: 2000 })
        expect(tracker.snapshot()).toMatchObject({ loadedBytes: 1000, remainingSeconds: null })
    })

    it('ages out a stalled transfer and recovers when bytes arrive again', () => {
        let time = 0
        const tracker = createUploadProgress([{ size: 10_000 }], () => time)
        const update = tracker.progressFor('0:original', { size: 10_000 })
        update({ loaded: 0 })
        time = 1000
        update({ loaded: 1000 })
        expect(tracker.snapshot().bytesPerSecond).toBe(1000)
        for (time = 1500; time <= 10_000; time += 500) tracker.snapshot()
        expect(tracker.snapshot()).toMatchObject({ bytesPerSecond: 0, remainingSeconds: null })
        time = 11_000
        update({ loaded: 2000 })
        expect(tracker.snapshot().bytesPerSecond).toBeGreaterThan(0)
        expect(tracker.snapshot().remainingSeconds).toBeGreaterThan(0)
    })

    it('formats readable decimal speed units and estimates without a false zero', () => {
        expect([0, 999, 1500, 2_500_000, 3_000_000_000].map(formatUploadBytes))
            .toEqual(['0 B', '999 B', '1.5 KB', '2.5 MB', '3.00 GB'])
        expect([0.1, 30, 60, 61, 3600, 3700].map(formatUploadTime))
            .toEqual(['1s', '30s', '1 min', '2 min', '1h', '1h 2 min'])
    })
})
