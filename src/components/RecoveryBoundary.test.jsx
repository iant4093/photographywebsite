import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { Suspense, useState } from 'react'
import RecoveryBoundary from './RecoveryBoundary'
import lazyRetry from '../utils/lazyRetry'

const Broken = () => { throw new Error('synthetic render failure') }
describe('page recovery', () => {
    it('contains route errors, resets on navigation, and isolates optional decoration', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const view = render(<div><nav>Navigation</nav><RecoveryBoundary key="first"><Broken /></RecoveryBoundary></div>)
        expect(screen.getByText('Navigation')).toBeInTheDocument()
        expect(screen.getByRole('alert')).toHaveTextContent('could not be opened')
        expect(screen.getByRole('link', { name:'Go to home' })).toHaveAttribute('href','/')
        view.rerender(<RecoveryBoundary key="second"><p>Recovered route</p></RecoveryBoundary>)
        expect(screen.getByText('Recovered route')).toBeInTheDocument()
        view.rerender(<RecoveryBoundary key="optional" optional><Broken /></RecoveryBoundary>)
        expect(screen.queryByRole('alert')).toBeNull()
    })
    it('resets a failed route without remounting healthy page state', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        function Page() {
            const [count, setCount] = useState(0)
            return <button onClick={() => setCount(count + 1)}>State {count}</button>
        }
        const view = render(<RecoveryBoundary resetKey="/search"><Page /></RecoveryBoundary>)
        fireEvent.click(screen.getByRole('button', {name:'State 0'}))
        view.rerender(<RecoveryBoundary resetKey="/search"><Page /></RecoveryBoundary>)
        expect(screen.getByRole('button', {name:'State 1'})).toBeInTheDocument()
        view.rerender(<RecoveryBoundary resetKey="/other"><Page /></RecoveryBoundary>)
        expect(screen.getByRole('button', {name:'State 1'})).toBeInTheDocument()
        view.rerender(<RecoveryBoundary resetKey="/broken"><Broken /></RecoveryBoundary>)
        expect(screen.getByRole('alert')).toBeInTheDocument()
        view.rerender(<RecoveryBoundary resetKey="/recovered"><p>New route</p></RecoveryBoundary>)
        expect(screen.getByText('New route')).toBeInTheDocument()
    })

    it('retries a recoverable import once without reloading the document', async () => {
        const loader = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch dynamically imported module'))
            .mockResolvedValue({default:()=> <button>Loaded route</button>})
        const Route = lazyRetry(loader)
        render(<RecoveryBoundary><Suspense fallback="Loading"><Route /></Suspense></RecoveryBoundary>)
        fireEvent.click(await screen.findByRole('button', {name:'Loaded route'}))
        expect(loader).toHaveBeenCalledTimes(2)
    })
    it('does not retry application bugs', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const loader=vi.fn().mockRejectedValue(new Error('invalid business state'))
        const Route=lazyRetry(loader)
        render(<RecoveryBoundary><Suspense fallback="Loading"><Route /></Suspense></RecoveryBoundary>)
        await screen.findByRole('alert')
        expect(loader).toHaveBeenCalledTimes(1)
    })
})
