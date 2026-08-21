import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ColorWheel, ToneCurve } from './DirectControls'
import { anchoredPan, curveCoordinates, gradeCoordinates } from './directControlMath'

const rectangle = { left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200, x: 0, y: 0, toJSON: () => ({}) }

describe('editor direct-manipulation controls', () => {
    beforeEach(() => {
        vi.stubGlobal('PointerEvent', MouseEvent)
    })

    it('converts curve pointer positions into input and output percentages', () => {
        expect(curveCoordinates(rectangle, 50, 150)).toEqual({ x: 25, y: 25 })
        expect(curveCoordinates(rectangle, -20, 240)).toEqual({ x: 0, y: 0 })
    })

    it('keeps the pixel below the cursor anchored while zooming', () => {
        expect(anchoredPan({
            cursorX: 700,
            cursorY: 250,
            centerX: 500,
            centerY: 400,
            currentPan: { x: 0, y: 0 },
            currentScale: 0.5,
            nextScale: 1,
        })).toEqual({ x: -200, y: 150 })
    })

    it('adds a tone-curve point directly on the graph without sliders', () => {
        const onChange = vi.fn()
        const onEditStart = vi.fn()
        const onEditEnd = vi.fn()
        render(<ToneCurve
            points={[{ x: 0, y: 0 }, { x: 100, y: 100 }]}
            onChange={onChange}
            onEditStart={onEditStart}
            onEditEnd={onEditEnd}
            onReset={() => {}}
        />)
        const graph = screen.getByRole('application', { name: /Tone curve/ })
        vi.spyOn(graph, 'getBoundingClientRect').mockReturnValue(rectangle)

        fireEvent.pointerDown(graph, { clientX: 80, clientY: 60, pointerId: 1 })
        fireEvent.pointerUp(graph, { pointerId: 1 })

        expect(onEditStart).toHaveBeenCalledTimes(1)
        expect(onChange).toHaveBeenCalledWith([{ x: 0, y: 0 }, { x: 40, y: 70 }, { x: 100, y: 100 }])
        expect(onEditEnd).toHaveBeenCalledTimes(1)
        expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument()
    })

    it('drags, removes, resets, and keyboard-adjusts curve points', () => {
        const points = [{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 100 }]
        const onChange = vi.fn()
        const onEditStart = vi.fn()
        const onEditEnd = vi.fn()
        const onReset = vi.fn()
        render(<ToneCurve points={points} onChange={onChange} onEditStart={onEditStart} onEditEnd={onEditEnd} onReset={onReset} />)
        const graph = screen.getByRole('application', { name: /Tone curve/ })
        vi.spyOn(graph, 'getBoundingClientRect').mockReturnValue(rectangle)

        fireEvent.pointerDown(graph, { clientX: 100, clientY: 100, pointerId: 3 })
        fireEvent.pointerMove(graph, { clientX: 120, clientY: 80, pointerId: 3 })
        fireEvent.pointerUp(graph, { pointerId: 3 })
        expect(onChange).toHaveBeenLastCalledWith([{ x: 0, y: 0 }, { x: 60, y: 60 }, { x: 100, y: 100 }])

        const middlePoint = screen.getByRole('slider', { name: 'Tone curve point 2' })
        fireEvent.keyDown(middlePoint, { key: 'ArrowUp' })
        expect(onChange).toHaveBeenLastCalledWith([{ x: 0, y: 0 }, { x: 50, y: 51 }, { x: 100, y: 100 }])
        fireEvent.keyDown(middlePoint, { key: 'Delete' })
        expect(onChange).toHaveBeenLastCalledWith([{ x: 0, y: 0 }, { x: 100, y: 100 }])

        fireEvent.doubleClick(graph, { clientX: 100, clientY: 100 })
        expect(onChange).toHaveBeenLastCalledWith([{ x: 0, y: 0 }, { x: 100, y: 100 }])
        fireEvent.click(screen.getByRole('button', { name: 'Reset curve' }))
        expect(onReset).toHaveBeenCalledTimes(1)
        expect(onEditStart).toHaveBeenCalled()
        expect(onEditEnd).toHaveBeenCalled()
    })

    it('maps the color wheel position to synchronized hue and saturation values', () => {
        expect(gradeCoordinates(rectangle, 100, 0)).toEqual({ hue: 0, saturation: 100 })
        expect(gradeCoordinates(rectangle, 200, 100)).toEqual({ hue: 90, saturation: 100 })

        const onChange = vi.fn()
        render(<ColorWheel label="midtones" hue={0} saturation={0} onChange={onChange} onEditStart={() => {}} onEditEnd={() => {}} />)
        const wheel = screen.getByRole('slider', { name: 'midtones color wheel' })
        vi.spyOn(wheel, 'getBoundingClientRect').mockReturnValue(rectangle)
        fireEvent.pointerDown(wheel, { clientX: 200, clientY: 100, pointerId: 2 })
        fireEvent.pointerMove(wheel, { clientX: 100, clientY: 200, pointerId: 2 })
        fireEvent.pointerUp(wheel, { pointerId: 2 })
        expect(onChange).toHaveBeenCalledWith({ hue: 90, saturation: 100 })
    })

    it('supports keyboard color-wheel changes', () => {
        const onChange = vi.fn()
        const onEditStart = vi.fn()
        const onEditEnd = vi.fn()
        render(<ColorWheel label="shadows" hue={1} saturation={99} onChange={onChange} onEditStart={onEditStart} onEditEnd={onEditEnd} />)
        const wheel = screen.getByRole('slider', { name: 'shadows color wheel' })
        fireEvent.keyDown(wheel, { key: 'ArrowLeft' })
        expect(onChange).toHaveBeenLastCalledWith({ hue: 359, saturation: 99 })
        fireEvent.keyDown(wheel, { key: 'ArrowUp' })
        expect(onChange).toHaveBeenLastCalledWith({ hue: 1, saturation: 100 })
        expect(onEditStart).toHaveBeenCalledTimes(2)
        expect(onEditEnd).toHaveBeenCalledTimes(2)
    })
})
