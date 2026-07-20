import { describe, expect, it } from 'vitest'
import { mapWithConcurrency } from './concurrency'

describe('mapWithConcurrency', () => {
    it('preserves input order and never exceeds the requested concurrency', async () => {
        let active = 0
        let maximumActive = 0
        const result = await mapWithConcurrency([4, 3, 2, 1], 2, async (value) => {
            active += 1
            maximumActive = Math.max(maximumActive, active)
            await new Promise((resolve) => setTimeout(resolve, value))
            active -= 1
            return value * 2
        })

        expect(result).toEqual([8, 6, 4, 2])
        expect(maximumActive).toBe(2)
    })

    it('handles empty input', async () => {
        expect(await mapWithConcurrency([], 3, () => null)).toEqual([])
    })
})
