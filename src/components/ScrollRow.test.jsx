import { act, fireEvent, render, screen } from '@testing-library/react'
import { Link, MemoryRouter, useLocation, useNavigate } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ScrollRow from './ScrollRow'
import { getHorizontalScroll, saveHorizontalScroll } from '../utils/scroll'

describe('horizontal scroll restoration', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('waits for enough row content without overwriting its saved position', async () => {
        let left = 0
        let maximum = 100
        const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollLeft')
        Object.defineProperty(Element.prototype, 'scrollLeft', {
            configurable: true,
            get: () => left,
            set: value => { left = Math.min(value, maximum) },
        })
        try {
            saveHorizontalScroll('delayed-row', 760)
            const view = render(<ScrollRow scrollKey="delayed-row"><div>First page</div></ScrollRow>)
            const row = view.container.querySelector('[data-scroll-row]')
            expect(row.scrollLeft).toBe(100)
            fireEvent.scroll(row)
            expect(getHorizontalScroll('delayed-row')).toBe(760)
            maximum = 1600
            view.rerender(<ScrollRow scrollKey="delayed-row"><div>First page</div><div>More albums</div></ScrollRow>)
            await act(async () => {})
            expect(row.scrollLeft).toBe(760)
        } finally {
            if (descriptor) Object.defineProperty(Element.prototype, 'scrollLeft', descriptor)
            else delete Element.prototype.scrollLeft
        }
    })

    it('keeps horizontal positions separate for repeat visits to the same page', () => {
        function Page() {
            const location = useLocation()
            const navigate = useNavigate()
            return <>
                <Link to="/" replace={false}>Another visit</Link>
                <button onClick={() => navigate(-1)}>Back</button>
                <ScrollRow key={location.key} scrollKey="visits"><div>Albums</div></ScrollRow>
            </>
        }
        const { container } = render(<MemoryRouter><Page /></MemoryRouter>)
        let row = container.querySelector('[data-scroll-row]')
        row.scrollLeft = 480
        fireEvent.scroll(row)
        fireEvent.click(screen.getByText('Another visit'))
        row = container.querySelector('[data-scroll-row]')
        row.scrollLeft = 960
        fireEvent.scroll(row)
        fireEvent.click(screen.getByText('Back'))
        expect(container.querySelector('[data-scroll-row]').scrollLeft).toBe(480)
    })
})
