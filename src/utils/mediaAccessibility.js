export function photoDescription(image, context = '', index = 0, total = 0) {
    const description = typeof image?.altText === 'string' ? image.altText.trim() : ''
    if (description) return description
    const album = image?.albumTitle || context.replace(/^Photo viewer for /i, '').trim()
    const position = `Photograph ${index + 1}${total ? ` of ${total}` : ''}`
    return album ? `${position} — ${album}` : position
}
