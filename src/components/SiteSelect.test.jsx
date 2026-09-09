import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import SiteSelect from './SiteSelect'
import { selectChoice } from '../test/selectChoice'

const OPTIONS = [
    { value: 'all', label: 'All categories' },
    { value: 'birds', label: 'Birding' },
    { value: 'hidden', label: 'Disabled category', disabled: true },
    { value: 'hikes', label: 'Hikes' },
]
function Controlled(props) {
    const [value, setValue] = useState(props.initialValue ?? 'all')
    return <SiteSelect aria-label="Category" options={OPTIONS} {...props} value={value} onChange={setValue} />
}

describe('SiteSelect', () => {
    it('renders its own choices and updates selection without native pickers', async () => {
        const user = userEvent.setup()
        const { container } = render(<Controlled />)
        const control = screen.getByRole('combobox', { name: 'Category' })
        expect(container.querySelector('select, datalist')).toBeNull()
        await user.click(control)
        const selected = screen.getByRole('option', { name: 'All categories' })
        expect(selected).toHaveAttribute('aria-selected', 'true')
        await user.click(screen.getByRole('option', { name: 'Hikes' }))
        expect(control).toHaveTextContent('Hikes')
        expect(control).toHaveFocus()
        expect(control).toHaveAttribute('aria-expanded', 'false')
        expect(screen.queryByRole('listbox')).toBeNull()
    })

    it('supports arrows, disabled-option skipping, Escape cancellation, and Enter commit', async () => {
        const user = userEvent.setup()
        render(<Controlled />)
        const control = screen.getByRole('combobox')
        control.focus()
        await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}')
        expect(document.getElementById(control.getAttribute('aria-activedescendant'))).toHaveTextContent('Hikes')
        expect(control).toHaveValue('all')
        await user.keyboard('{Escape}')
        expect(control).toHaveValue('all')
        await user.keyboard('{ArrowUp}{End}{Enter}')
        expect(control).toHaveValue('hikes')
        expect(control).toHaveAttribute('aria-expanded', 'false')
        await user.keyboard('{Home}{Enter}')
        expect(control).toHaveValue('all')
    })

    it('supports type-to-find and Tab commitment without trapping focus', async () => {
        const user = userEvent.setup()
        render(<><Controlled /><button>Next field</button></>)
        screen.getByRole('combobox').focus()
        await user.keyboard('hi')
        expect(screen.getByRole('option', { name: 'Hikes' })).toHaveAttribute('data-active', 'true')
        await user.tab()
        expect(screen.getByRole('combobox')).toHaveValue('hikes')
        expect(screen.getByRole('button', { name: 'Next field' })).toHaveFocus()
        expect(screen.queryByRole('listbox')).toBeNull()
    })

    it('keeps required fields from submitting, exposes an error, and submits the selected value', async () => {
        const user = userEvent.setup()
        const submit = vi.fn(event => event.preventDefault())
        render(<form onSubmit={submit}><Controlled initialValue="" required name="category" /><button>Save</button></form>)
        const control = screen.getByRole('combobox')
        await user.click(screen.getByRole('button', { name: 'Save' }))
        expect(submit).not.toHaveBeenCalled()
        expect(control).toHaveFocus()
        expect(control).toHaveAttribute('aria-invalid', 'true')
        expect(screen.getByRole('alert')).toHaveTextContent('Choose an option')
        selectChoice(control, 'birds')
        await user.click(screen.getByRole('button', { name: 'Save' }))
        expect(submit).toHaveBeenCalledOnce()
        expect(new FormData(control.closest('form')).get('category')).toBe('birds')
    })

    it('does not activate disabled controls or disabled options', async () => {
        const user = userEvent.setup()
        const change = vi.fn()
        const view = render(<SiteSelect aria-label="Category" disabled options={OPTIONS} value="all" onChange={change} />)
        await user.click(screen.getByRole('combobox'))
        expect(screen.queryByRole('listbox')).toBeNull()
        view.rerender(<SiteSelect aria-label="Category" options={OPTIONS} value="all" onChange={change} />)
        await user.click(screen.getByRole('combobox'))
        await user.click(screen.getByRole('option', { name: 'Disabled category' }))
        expect(change).not.toHaveBeenCalled()
    })

    it('filters editable suggestions while preserving new categories and standard editing keys', async () => {
        const user = userEvent.setup()
        render(<Controlled editable initialValue="" options={['Travel', 'Wildlife']} />)
        const input = screen.getByRole('combobox')
        await user.type(input, 'tra')
        expect(screen.getByRole('option', { name: 'Travel' })).toBeInTheDocument()
        expect(screen.queryByRole('option', { name: 'Wildlife' })).toBeNull()
        await user.keyboard('{ArrowDown}{Enter}')
        expect(input).toHaveValue('Travel')
        await user.clear(input)
        await user.type(input, 'New category')
        expect(screen.getByText(/Keep typing to use a new one/)).toBeInTheDocument()
        await user.keyboard('{Home}A{End}!{Escape}')
        expect(input).toHaveValue('ANew category!')
        expect(input).toHaveAttribute('aria-expanded', 'false')
    })

    it('closes on outside interaction and consumes Escape before a parent dialog', async () => {
        const user = userEvent.setup()
        const parentKey = vi.fn()
        render(<div role="dialog" onKeyDown={parentKey}><Controlled /><button>Outside</button></div>)
        const control = screen.getByRole('combobox')
        await user.click(control)
        expect(screen.getByRole('dialog')).toContainElement(screen.getByRole('listbox'))
        await user.keyboard('{Escape}')
        expect(parentKey).not.toHaveBeenCalled()
        await user.click(control)
        await user.click(screen.getByRole('button', { name: 'Outside' }))
        expect(screen.queryByRole('listbox')).toBeNull()
    })

    it('flips upward near the viewport edge and fits a narrow viewport', () => {
        render(<Controlled />)
        const control = screen.getByRole('combobox')
        vi.spyOn(control, 'getBoundingClientRect').mockReturnValue({ left: window.innerWidth - 60, top: window.innerHeight - 55, bottom: window.innerHeight - 12, width: 150, height: 43 })
        fireEvent.click(control)
        const menu = screen.getByRole('listbox')
        expect(Number.parseFloat(menu.style.top)).toBeLessThan(window.innerHeight - 55)
        expect(Number.parseFloat(menu.style.left) + Number.parseFloat(menu.style.width)).toBeLessThanOrEqual(window.innerWidth - 8)
        expect(menu.style.maxHeight).toBe('320px')
    })

    it('places menus inside the fullscreen surface and handles changing option lists', () => {
        const fullscreen = document.createElement('div')
        document.body.append(fullscreen)
        Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: fullscreen })
        const view = render(<SiteSelect aria-label="Category" options={OPTIONS} value="all" />)
        fireEvent.click(screen.getByRole('combobox'))
        expect(fullscreen).toContainElement(screen.getByRole('listbox'))
        view.rerender(<SiteSelect aria-label="Category" options={[]} value="all" />)
        expect(screen.getByText('No options available.')).toBeInTheDocument()
        fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' })
        expect(screen.getByRole('combobox')).not.toHaveAttribute('aria-activedescendant')
        view.unmount()
        fullscreen.remove()
        delete document.fullscreenElement
    })

    it('cleans up an open menu and its listeners on unmount', async () => {
        const view = render(<Controlled />)
        fireEvent.click(screen.getByRole('combobox'))
        view.unmount()
        await act(async () => {
            fireEvent.scroll(document)
            fireEvent.resize(window)
        })
        expect(screen.queryByRole('listbox')).toBeNull()
    })

    it('coalesces scroll and resize positioning into one frame and cancels pending work on close', () => {
        let frame
        const request = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frame = callback; return 42 })
        const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
        render(<Controlled />)
        const control = screen.getByRole('combobox')
        fireEvent.click(control)
        const measure = vi.spyOn(control, 'getBoundingClientRect')
        for (let index = 0; index < 20; index += 1) fireEvent.scroll(document)
        fireEvent.resize(window)
        expect(request).toHaveBeenCalledOnce()
        expect(measure).not.toHaveBeenCalled()
        act(() => frame())
        expect(measure).toHaveBeenCalledOnce()
        fireEvent.scroll(document)
        fireEvent.keyDown(control, { key: 'Escape' })
        expect(cancel).toHaveBeenCalledWith(42)
        expect(screen.queryByRole('listbox')).toBeNull()
    })

    it('tracks an animated ancestor while open without reacting to unrelated styles', async () => {
        let frame
        const request = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frame = callback; return 42 })
        render(<><section data-testid="moving-section"><Controlled /></section><aside data-testid="unrelated" /></>)
        const control = screen.getByRole('combobox')
        const measure = vi.spyOn(control, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 140, left: 20, width: 200 })
        fireEvent.click(control)
        expect(screen.getByRole('listbox').style.top).toBe('146px')
        await act(async () => { screen.getByTestId('unrelated').style.transform = 'translateY(10px)' })
        expect(request).not.toHaveBeenCalled()
        measure.mockReturnValue({ top: 80, bottom: 120, left: 20, width: 200 })
        await act(async () => { screen.getByTestId('moving-section').style.transform = 'translateY(-20px)' })
        expect(request).toHaveBeenCalledOnce()
        act(() => frame())
        expect(screen.getByRole('listbox').style.top).toBe('126px')
        fireEvent.keyDown(control, { key: 'Escape' })
        request.mockClear()
        await act(async () => { screen.getByTestId('moving-section').style.transform = 'translateY(-40px)' })
        expect(request).not.toHaveBeenCalled()
    })

    it('keeps all application dropdowns and playback menus out of native pickers', () => {
        const sources = import.meta.glob('../**/*.{jsx,js}', { query: '?raw', import: 'default', eager: true })
        for (const [path, source] of Object.entries(sources)) {
            if (path.includes('.test.') || path.includes('/test/')) continue
            expect(source, path).not.toMatch(/<(?:select|datalist)\b/)
            expect(source, path).not.toMatch(/<video\b[^>]*\bcontrols(?:\s|=|>)/)
        }
    })
})
