export const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

export function curveCoordinates(rect, clientX, clientY) {
    return {
        x: clamp((clientX - rect.left) / Math.max(1, rect.width) * 100, 0, 100),
        y: clamp(100 - (clientY - rect.top) / Math.max(1, rect.height) * 100, 0, 100),
    }
}

export function gradeCoordinates(rect, clientX, clientY) {
    const centerX = rect.left + rect.width / 2
    const centerY = rect.top + rect.height / 2
    const deltaX = clientX - centerX
    const deltaY = clientY - centerY
    const radius = Math.max(1, Math.min(rect.width, rect.height) / 2)
    return {
        hue: (Math.atan2(deltaY, deltaX) * 180 / Math.PI + 90 + 360) % 360,
        saturation: clamp(Math.hypot(deltaX, deltaY) / radius * 100, 0, 100),
    }
}

export function anchoredPan({ cursorX, cursorY, centerX, centerY, currentPan, currentScale, nextScale }) {
    const screenX = cursorX - centerX
    const screenY = cursorY - centerY
    const safeCurrentScale = Math.max(0.0001, currentScale)
    return {
        x: screenX - ((screenX - currentPan.x) / safeCurrentScale) * nextScale,
        y: screenY - ((screenY - currentPan.y) / safeCurrentScale) * nextScale,
    }
}
