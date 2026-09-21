import { StrictMode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { Link, MemoryRouter, Route, Routes, useNavigate, useSearchParams } from 'react-router'
import { describe, expect, it } from 'vitest'
import useNavigationState from './useNavigationState'

function Catalog() {
    const [sort, setSort] = useNavigationState('sort', 'curated')
    const [items, setItems] = useNavigationState('pages', [1])
    const [params, setParams] = useSearchParams()
    return <>
        <p>{sort}:{items.join(',')}:{params.get('type') || 'photo'}</p>
        <button onClick={() => setSort('newest')}>Sort</button>
        <button onClick={() => setItems(items => [...items, items.length + 1])}>More</button>
        <button onClick={() => setParams({ type: 'video' })}>Videos</button>
        <button onClick={() => setParams({ type: 'all' }, { replace: true })}>Replace filter</button>
        <Link to="/album">Album</Link>
    </>
}
function Navigation() {
    const navigate = useNavigate()
    return <><button onClick={() => navigate(-1)}>Back</button><button onClick={() => navigate(1)}>Forward</button></>
}
const mount = () => render(<StrictMode><MemoryRouter><Navigation /><Routes>
    <Route path="/" element={<Catalog />} />
    <Route path="/album" element={<p>Detail</p>} />
</Routes></MemoryRouter></StrictMode>)

describe('browsing state with navigation', () => {
    it('restores filters and all loaded pages when returning from an album', () => {
        mount()
        fireEvent.click(screen.getByText('Sort'))
        fireEvent.click(screen.getByText('More'))
        fireEvent.click(screen.getByText('Album'))
        fireEvent.click(screen.getByText('Back'))
        expect(screen.getByText('newest:1,2:photo')).toBeInTheDocument()
    })
    it('separates history entries and transfers state across query replacements', () => {
        mount()
        fireEvent.click(screen.getByText('Videos'))
        fireEvent.click(screen.getByText('More'))
        fireEvent.click(screen.getByText('Replace filter'))
        expect(screen.getByText('curated:1,2:all')).toBeInTheDocument()
        fireEvent.click(screen.getByText('Back'))
        expect(screen.getByText('curated:1:photo')).toBeInTheDocument()
        fireEvent.click(screen.getByText('Forward'))
        expect(screen.getByText('curated:1,2:all')).toBeInTheDocument()
    })
})
