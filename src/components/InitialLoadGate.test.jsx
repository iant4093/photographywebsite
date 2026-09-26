import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import InitialLoadGate from './InitialLoadGate'

describe('initial load screen', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.spyOn(performance, 'now').mockReturnValue(500)
        document.body.innerHTML = '<div id="initial-loader"></div><div id="root"><main id="main-content"></main></div>'
    })

    afterEach(() => {
        vi.restoreAllMocks()
        vi.useRealTimers()
    })

    it('waits for the home hero before revealing the initial page', () => {
        const hero = document.createElement('img')
        hero.className = 'home-hero-media'
        document.getElementById('main-content').appendChild(hero)
        render(<InitialLoadGate />)

        act(() => vi.advanceTimersByTime(500))
        expect(document.getElementById('initial-loader')).toBeInTheDocument()

        fireEvent.load(hero)
        act(() => vi.advanceTimersByTime(240))
        expect(document.getElementById('initial-loader')).toBeNull()
    })

    it('keeps a fast non-hero page visible only after the brief opening animation', () => {
        vi.mocked(performance.now).mockReturnValue(0)
        render(<InitialLoadGate />)

        act(() => vi.advanceTimersByTime(349))
        expect(document.getElementById('initial-loader')).toBeInTheDocument()

        act(() => vi.advanceTimersByTime(1 + 240))
        expect(document.getElementById('initial-loader')).toBeNull()
    })

    it('uses a short timeout if the hero cannot load', () => {
        const hero = document.createElement('img')
        hero.className = 'video-hero-media'
        document.getElementById('main-content').appendChild(hero)
        render(<InitialLoadGate />)

        act(() => vi.advanceTimersByTime(1600))
        act(() => vi.runAllTimers())
        expect(document.getElementById('initial-loader')).toBeNull()
    })
})
