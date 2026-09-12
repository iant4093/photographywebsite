// Match the cover heights in linen.css and the parallax overscan in index.css.
// A tall object-fit: cover crop scales a landscape image by height, so 100vw
// alone requests too few pixels on phones. Leave DPR selection to the browser.
export function heroImageSizes(source, heroType = 'photo') {
    const ratio = source?.width > 0 && source?.height > 0
        ? source.width / source.height : 1.5
    const number = (value) => Number(value.toFixed(5))
    const sizes = (minimumRem, scale, extraPixels = 0) => (
        `max(100vw, calc(clamp(${number(minimumRem * ratio * scale)}rem, ${number(92 * ratio * scale)}svh, ${number(780 * ratio * scale)}px) + ${number(extraPixels * ratio)}px))`
    )
    if (heroType === 'video') {
        return `(min-width: 768px) ${sizes(46.5, 1, 60)}, ${sizes(37, 1, 60)}`
    }
    return `(min-width: 768px) ${sizes(46.5, 1.04)}, ${sizes(37, 1, 24)}`
}
