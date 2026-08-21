import { useRef, useState } from 'react'
import { clamp, curveCoordinates, gradeCoordinates } from './directControlMath'

function closestPoint(points, coordinates) {
    let closestIndex = -1
    let closestDistance = Infinity
    points.forEach((point, index) => {
        const distance = Math.hypot(point.x - coordinates.x, point.y - coordinates.y)
        if (distance < closestDistance) {
            closestIndex = index
            closestDistance = distance
        }
    })
    return { index: closestIndex, distance: closestDistance }
}

export function ToneCurve({ points, onChange, onEditStart, onEditEnd, onReset }) {
    const surfaceRef = useRef(null)
    const activePointRef = useRef(null)
    const [selectedPoint, setSelectedPoint] = useState(null)

    const updatePoint = (index, coordinates) => {
        const next = points.map((point) => ({ ...point }))
        const isEndpoint = index === 0 || index === next.length - 1
        const minimumX = index > 0 ? next[index - 1].x + 1 : 0
        const maximumX = index < next.length - 1 ? next[index + 1].x - 1 : 100
        next[index] = {
            x: isEndpoint ? next[index].x : clamp(coordinates.x, minimumX, maximumX),
            y: coordinates.y,
        }
        onChange(next)
    }

    const handlePointerDown = (event) => {
        const coordinates = curveCoordinates(surfaceRef.current.getBoundingClientRect(), event.clientX, event.clientY)
        const nearest = closestPoint(points, coordinates)
        onEditStart()
        let pointIndex = nearest.index
        if (nearest.distance > 6 && points.length < 16) {
            const next = [...points.map((point) => ({ ...point })), coordinates].sort((first, second) => first.x - second.x)
            pointIndex = next.findIndex((point) => point === coordinates)
            onChange(next)
        } else {
            updatePoint(pointIndex, coordinates)
        }
        activePointRef.current = pointIndex
        setSelectedPoint(pointIndex)
        event.currentTarget.setPointerCapture?.(event.pointerId)
    }

    const handlePointerMove = (event) => {
        if (activePointRef.current === null) return
        updatePoint(activePointRef.current, curveCoordinates(surfaceRef.current.getBoundingClientRect(), event.clientX, event.clientY))
    }

    const finishPointerEdit = (event) => {
        if (activePointRef.current === null) return
        activePointRef.current = null
        event.currentTarget.releasePointerCapture?.(event.pointerId)
        onEditEnd()
    }

    const removePoint = (event) => {
        const coordinates = curveCoordinates(surfaceRef.current.getBoundingClientRect(), event.clientX, event.clientY)
        const nearest = closestPoint(points, coordinates)
        if (nearest.distance > 6 || nearest.index <= 0 || nearest.index >= points.length - 1) return
        onEditStart()
        onChange(points.filter((_point, index) => index !== nearest.index))
        setSelectedPoint(null)
        onEditEnd()
    }

    const handlePointKeyDown = (event, index) => {
        if ((event.key === 'Delete' || event.key === 'Backspace') && index > 0 && index < points.length - 1) {
            event.preventDefault()
            onEditStart()
            onChange(points.filter((_point, pointIndex) => pointIndex !== index))
            setSelectedPoint(null)
            onEditEnd()
            return
        }
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
        event.preventDefault()
        const point = points[index]
        onEditStart()
        updatePoint(index, {
            x: point.x + (event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0),
            y: point.y + (event.key === 'ArrowDown' ? -1 : event.key === 'ArrowUp' ? 1 : 0),
        })
        onEditEnd()
    }

    return (
        <div className="editor-curve-control">
            <svg
                ref={surfaceRef}
                className="editor-curve-editor"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                role="application"
                aria-label="Tone curve. Click to add a point and drag points to adjust input and output tones."
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={finishPointerEdit}
                onPointerCancel={finishPointerEdit}
                onDoubleClick={removePoint}
            >
                <polyline points={points.map((point) => `${point.x},${100 - point.y}`).join(' ')} />
                {points.map((point, index) => (
                    <circle
                        key={`${index}-${point.x.toFixed(2)}`}
                        className={selectedPoint === index ? 'is-selected' : ''}
                        cx={point.x}
                        cy={100 - point.y}
                        r="2.25"
                        tabIndex="0"
                        role="slider"
                        aria-label={`Tone curve point ${index + 1}`}
                        aria-valuemin="0"
                        aria-valuemax="100"
                        aria-valuenow={Math.round(point.y)}
                        aria-valuetext={`Input ${Math.round(point.x)}, output ${Math.round(point.y)}`}
                        onFocus={() => setSelectedPoint(index)}
                        onKeyDown={(event) => handlePointKeyDown(event, index)}
                    />
                ))}
            </svg>
            <div className="editor-direct-control-footer">
                <span>Click to add · drag to shape · double-click to remove</span>
                <button type="button" onClick={onReset}>Reset curve</button>
            </div>
        </div>
    )
}

export function ColorWheel({ label, hue, saturation, onChange, onEditStart, onEditEnd }) {
    const wheelRef = useRef(null)
    const activeRef = useRef(false)
    const angle = (hue - 90) * Math.PI / 180
    const radius = saturation * 0.44
    const markerStyle = {
        left: `${50 + Math.cos(angle) * radius}%`,
        top: `${50 + Math.sin(angle) * radius}%`,
        backgroundColor: `hsl(${hue} 82% 55%)`,
    }

    const update = (event) => {
        onChange(gradeCoordinates(wheelRef.current.getBoundingClientRect(), event.clientX, event.clientY))
    }

    const handlePointerDown = (event) => {
        activeRef.current = true
        onEditStart()
        update(event)
        event.currentTarget.setPointerCapture?.(event.pointerId)
    }

    const finish = (event) => {
        if (!activeRef.current) return
        activeRef.current = false
        event.currentTarget.releasePointerCapture?.(event.pointerId)
        onEditEnd()
    }

    const handleKeyDown = (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
        event.preventDefault()
        onEditStart()
        onChange({
            hue: (hue + (event.key === 'ArrowLeft' ? -2 : event.key === 'ArrowRight' ? 2 : 0) + 360) % 360,
            saturation: clamp(saturation + (event.key === 'ArrowDown' ? -2 : event.key === 'ArrowUp' ? 2 : 0), 0, 100),
        })
        onEditEnd()
    }

    return (
        <div
            ref={wheelRef}
            className="editor-color-wheel"
            role="slider"
            tabIndex="0"
            aria-label={`${label} color wheel`}
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={Math.round(saturation)}
            aria-valuetext={`Hue ${Math.round(hue)}, saturation ${Math.round(saturation)}`}
            onPointerDown={handlePointerDown}
            onPointerMove={(event) => { if (activeRef.current) update(event) }}
            onPointerUp={finish}
            onPointerCancel={finish}
            onKeyDown={handleKeyDown}
        >
            <span className="editor-color-wheel-marker" style={markerStyle} />
        </div>
    )
}
