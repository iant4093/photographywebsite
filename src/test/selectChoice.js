import { fireEvent, screen, within } from '@testing-library/react'

// Exercise the rendered custom menu instead of dispatching native select events.
export function selectChoice(control, value) {
    if (control.getAttribute('aria-expanded') !== 'true') fireEvent.click(control)
    const menu = document.getElementById(control.getAttribute('aria-controls'))
    const option = within(menu).getAllByRole('option').find(item => item.dataset.value === String(value))
    if (!option) throw new Error(`Missing dropdown choice: ${value}`)
    fireEvent.click(option)
}

export function expectSuggestion(control, label) {
    fireEvent.focus(control)
    return screen.getByRole('option', { name: label })
}
