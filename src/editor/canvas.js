export function dimensionsForGeometry(width, height, geometry) {
    const cropWidth = Math.max(1, Math.round(width * geometry.crop.width))
    const cropHeight = Math.max(1, Math.round(height * geometry.crop.height))
    const turns = ((Math.round(geometry.quarterTurns) % 4) + 4) % 4
    return turns % 2 ? { width: cropHeight, height: cropWidth } : { width: cropWidth, height: cropHeight }
}

export function fittedGeometryDimensions(width, height, geometry, maxWidth = Infinity, maxHeight = Infinity) {
    const natural = dimensionsForGeometry(width, height, geometry)
    const scale = Math.min(1, maxWidth / natural.width, maxHeight / natural.height)
    return {
        width: Math.max(1, Math.round(natural.width * scale)),
        height: Math.max(1, Math.round(natural.height * scale)),
    }
}

export function drawGeometryAtSize(source, target, geometry, targetWidth, targetHeight) {
    const sourceWidth = source.width
    const sourceHeight = source.height
    const sourceX = Math.round(sourceWidth * geometry.crop.x)
    const sourceY = Math.round(sourceHeight * geometry.crop.y)
    const sourceCropWidth = Math.max(1, Math.round(sourceWidth * geometry.crop.width))
    const sourceCropHeight = Math.max(1, Math.round(sourceHeight * geometry.crop.height))
    const turns = ((Math.round(geometry.quarterTurns) % 4) + 4) % 4
    target.width = Math.max(1, Math.round(targetWidth))
    target.height = Math.max(1, Math.round(targetHeight))
    const context = target.getContext('2d', { alpha: false })
    context.save()
    context.fillStyle = '#191713'
    context.fillRect(0, 0, target.width, target.height)
    context.translate(target.width / 2, target.height / 2)
    context.scale(geometry.flipX ? -1 : 1, geometry.flipY ? -1 : 1)
    const rotation = (geometry.quarterTurns * 90 + geometry.rotation) * Math.PI / 180
    context.rotate(rotation)
    const skewX = Math.tan((geometry.horizontal || 0) * Math.PI / 360)
    const skewY = Math.tan((geometry.vertical || 0) * Math.PI / 360)
    context.transform(1, skewY, skewX, 1, 0, 0)
    const drawWidth = turns % 2 ? target.height : target.width
    const drawHeight = turns % 2 ? target.width : target.height
    context.drawImage(source, sourceX, sourceY, sourceCropWidth, sourceCropHeight, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight)
    context.restore()
    return target
}

export function drawGeometry(source, target, geometry, maxWidth = Infinity, maxHeight = Infinity) {
    const dimensions = fittedGeometryDimensions(source.width, source.height, geometry, maxWidth, maxHeight)
    return drawGeometryAtSize(source, target, geometry, dimensions.width, dimensions.height)
}

export function cropForAspect(width, height, aspect) {
    if (!aspect || aspect === 'free' || aspect === 'original') return { x: 0, y: 0, width: 1, height: 1 }
    const [ratioWidth, ratioHeight] = aspect.split(':').map(Number)
    if (!ratioWidth || !ratioHeight) return { x: 0, y: 0, width: 1, height: 1 }
    const desired = ratioWidth / ratioHeight
    const current = width / height
    if (current > desired) {
        const normalizedWidth = desired / current
        return { x: (1 - normalizedWidth) / 2, y: 0, width: normalizedWidth, height: 1 }
    }
    const normalizedHeight = current / desired
    return { x: 0, y: (1 - normalizedHeight) / 2, width: 1, height: normalizedHeight }
}

export function outputDimensions(width, height, geometry, { mode = 'original', value = 2048 } = {}) {
    const natural = dimensionsForGeometry(width, height, geometry)
    if (mode === 'original') return natural
    if (mode === 'width') {
        const nextWidth = Math.min(natural.width, Math.max(1, value))
        return { width: nextWidth, height: Math.max(1, Math.round(natural.height * nextWidth / natural.width)) }
    }
    if (mode === 'height') {
        const nextHeight = Math.min(natural.height, Math.max(1, value))
        return { width: Math.max(1, Math.round(natural.width * nextHeight / natural.height)), height: nextHeight }
    }
    const longEdge = Math.min(Math.max(natural.width, natural.height), Math.max(1, value))
    const scale = longEdge / Math.max(natural.width, natural.height)
    return { width: Math.max(1, Math.round(natural.width * scale)), height: Math.max(1, Math.round(natural.height * scale)) }
}

export function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => canvas.toBlob((blob) => {
        if (blob) resolve(blob)
        else reject(new Error('The browser could not encode this image.'))
    }, type, quality))
}
