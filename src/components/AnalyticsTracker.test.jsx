import { act, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AnalyticsTracker from './AnalyticsTracker'
import { flushAnalytics, resetAnalyticsForTests, trackPageView } from '../utils/analytics'

const api = vi.hoisted(() => ({ sendAnalyticsEvents: vi.fn() }))
vi.mock('../utils/api', () => ({ sendAnalyticsEvents: api.sendAnalyticsEvents }))
vi.mock('web-vitals', () => ({ onCLS: vi.fn(), onINP: vi.fn(), onLCP: vi.fn() }))

beforeEach(() => {
    resetAnalyticsForTests()
    localStorage.clear()
    api.sendAnalyticsEvents.mockReset().mockResolvedValue({ accepted: 1 })
})
afterEach(() => { resetAnalyticsForTests(); vi.restoreAllMocks() })

it.each(['pagehide', 'visibilitychange'])('flushes queued events on %s without waiting for a slow upload', async (event) => {
    let finish
    api.sendAnalyticsEvents.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const view = render(<MemoryRouter><AnalyticsTracker /></MemoryRouter>)
    await act(async () => {})
    const pending = flushAnalytics()
    trackPageView()
    if (event === 'visibilitychange') vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    await act(async () => (event === 'pagehide' ? window : document).dispatchEvent(new Event(event)))
    expect(api.sendAnalyticsEvents).toHaveBeenCalledTimes(2)
    expect(api.sendAnalyticsEvents).toHaveBeenLastCalledWith([{ name: 'page_view' }])
    finish()
    await pending
    view.unmount()
    trackPageView()
    await act(async () => (event === 'pagehide' ? window : document).dispatchEvent(new Event(event)))
    expect(api.sendAnalyticsEvents).toHaveBeenCalledTimes(2)
})
