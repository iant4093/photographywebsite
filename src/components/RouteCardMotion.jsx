import { useLayoutEffect, useRef } from 'react'
import { useLocation, useNavigationType } from 'react-router'
import { watchTouchScroll } from '../utils/touchScrollIntent'
import './RouteCardMotion.css'

const reducedMotion = '(prefers-reduced-motion: reduce)'
const floatingTracks = '.floating-loop-track'
const mainPage = () => document.getElementById('main-content')
const navbar = () => document.querySelector('.linen-site > .linen-nav')
const pathOf = location => location.pathname + location.search
const motionAllowed = () => typeof document.body.animate === 'function' && !window.matchMedia(reducedMotion).matches
const touchMotion = () => window.matchMedia('(pointer: coarse)').matches
const cardPath = card => card.dataset.routeTarget || card.pathname + card.search
const easing = 'cubic-bezier(.23,.65,.27,1)'
const albumEasing = 'cubic-bezier(.28,.16,.27,1)'
const clippedEasing = 'cubic-bezier(.38,.06,.24,1)'
const floatingEasing = 'cubic-bezier(.26,.45,.25,1)'
const openClip = 'inset(0px 0px 0px 0px)'

function viewportRect(rect, clip, allowEdge = false) {
    const left = Math.max(0, rect.left, clip?.left ?? 0)
    const top = Math.max(0, rect.top, clip?.top ?? 0)
    const right = Math.min(innerWidth, rect.right, clip?.right ?? innerWidth)
    const bottom = Math.min(innerHeight, rect.bottom, clip?.bottom ?? innerHeight)
    return right - left >= (allowEdge ? 12 : 32) && bottom - top >= (allowEdge ? 12 : 28)
        ? { left, top, width: right - left, height: bottom - top } : null
}

function titleClip(crop, preserveInk = false) {
    if (!crop && !preserveInk) return 'inset(0%)'
    const insets = (crop ?? [0, 0, 0, 0]).map((amount, index) =>
        preserveInk && index % 2 === 0 && amount === 0 ? '-0.25em' : `${amount}%`)
    return `inset(${insets.join(' ')})`
}

function titleGeometry(element, frame) {
    if (!element) return null
    const rect = element.getBoundingClientRect()
    const { left, top, width, height } = rect
    if (!width || !height) return null
    if (!frame && (left < 0 || top < 0 || left + width > innerWidth + 1 || top + height > innerHeight + 1)) return null
    const cut = frame && [
        Math.max(0, frame.top - top), Math.max(0, rect.right - frame.left - frame.width),
        Math.max(0, rect.bottom - frame.top - frame.height), Math.max(0, frame.left - left),
    ]
    if (cut && (width - cut[1] - cut[3] < 8 || height - cut[0] - cut[2] < 8)) return null
    const text = (element.dataset.title ?? element.textContent).trim().replace(/\s+/g, ' ')
    const crop = cut?.some(value => value > 1)
        ? cut.map((value, index) => value * 100 / (index % 2 ? width : height)) : undefined
    return text ? { text, alias: element.dataset.routeTitleAlias, rect, crop } : null
}

function readTitleStyle(pose) {
    if (!pose?.title) return pose
    const { title, element, boundary, boundaryRect, preserveInk } = pose
    const { left, width, height } = title.rect
    const css = getComputedStyle(element)
    const { color, fontFamily, fontSize, fontWeight, fontStyle, fontKerning, fontFeatureSettings,
        fontVariationSettings, fontOpticalSizing, letterSpacing, lineHeight, textAlign, textTransform,
        whiteSpace, overflowWrap, wordBreak, textWrap, textOverflow, overflow, boxSizing, padding } = css
    const layoutWidth = Number.parseFloat(css.width) || width
    const layoutHeight = Number.parseFloat(css.height) || height
    // Recreate the carousel's mask in the title's own coordinates so the
    // moving copy starts and ends with the same faded edge as the card.
    const maskImage = boundary && getComputedStyle(boundary).maskImage
    const mask = maskImage?.startsWith('linear-gradient(') ? {
        maskImage,
        maskSize: `${boundaryRect.width * layoutWidth / width}px 100%`,
        maskPosition: `${(boundaryRect.left - left) * layoutWidth / width}px 0px`,
        maskRepeat: 'no-repeat',
    } : undefined
    const style = {
        width: `${layoutWidth}px`, color, fontFamily, fontSize, fontWeight, fontStyle, fontKerning, fontFeatureSettings,
        fontVariationSettings, fontOpticalSizing, letterSpacing, lineHeight, textAlign, textTransform,
        whiteSpace, overflowWrap, wordBreak, textWrap, textOverflow, overflow, boxSizing, padding,
        ...(title.crop && { clipPath: titleClip(title.crop, preserveInk) }),
        ...(preserveInk && overflow === 'hidden' && { paddingBottom: `${Number.parseFloat(css.paddingBottom) + 2}px` }),
        ...mask,
    }
    return { ...pose, title: { ...title, layoutWidth, layoutHeight, style } }
}

function matchingTitles(from, to) {
    return from && to && (from.text === to.text || from.alias === to.text || from.text === to.alias)
}

function geometry(rect) {
    return Object.fromEntries(['left', 'top', 'width', 'height'].map(name => [name, `${rect[name]}px`]))
}

function cardPose(card) {
    const rect = card.getBoundingClientRect()
    const boundary = card.closest('[data-scroll-row], .floating-lane, .photo-stats-timeline-scroll')
    const boundaryRect = boundary?.getBoundingClientRect()
    const marker = card.dataset.routeCard
    const album = albumCardMarkers.has(marker)
    const frame = viewportRect(rect, boundaryRect, album)
    if (!frame) return null
    const clipped = rect.width - frame.width > 1 || rect.height - frame.height > 1
    // A thin crop is too small to provide a visible anchor for the heading.
    const sliver = album && (frame.width < rect.width / 4 || frame.height < rect.height / 4)
    const title = card.querySelector('[data-route-title], h2, h3') || card.querySelector('[data-title], strong')
    const edge = clipped ? {
        x: frame.left - rect.left > 1 ? -1 : rect.right - frame.width - frame.left > 1 ? 1 : 0,
        y: frame.top - rect.top > 1 ? -1 : rect.bottom - frame.height - frame.top > 1 ? 1 : 0,
    } : null
    // A horizontal crop only needs the sides of the row. A moving title
    // crossing its top or bottom would otherwise lose its descenders.
    const inlineClip = (marker === 'timeline' || marker === 'floating') && edge?.y === 0
    const clip = clipped && boundaryRect ? `inset(${[
        inlineClip ? 0 : boundaryRect.top, innerWidth - boundaryRect.right,
        inlineClip ? 0 : innerHeight - boundaryRect.bottom, boundaryRect.left,
    ].map(value => `${Math.max(0, value)}px`).join(' ')})` : openClip
    const inlineBounds = inlineClip && boundaryRect && { left: Math.max(0, boundaryRect.left), right: Math.min(innerWidth, boundaryRect.right) }
    return { frame, clipped, clip, edge, inlineBounds, boundary, boundaryRect, preserveInk: marker === 'timeline' && inlineClip,
        title: sliver ? null : titleGeometry(title, frame), element: title, card }
}

function headingPose(heading) {
    if (!heading) return null
    for (let element = heading; element && element !== mainPage(); element = element.parentElement) {
        for (const animation of element.getAnimations()) {
            if (animation.animationName === 'fade-in' || animation.animationName === 'slide-up') animation.finish()
        }
    }
    const header = heading.closest('.linen-gallery-header, .linen-section-heading, .cam-title') || heading.parentElement
    const frame = viewportRect(header.getBoundingClientRect())
    return frame ? { frame, title: titleGeometry(heading), element: heading } : null
}

function floatingPhases(wall) {
    return wall && [...wall.querySelectorAll(floatingTracks)]
        .map(track => track.getAnimations()[0]?.effect?.getComputedTiming().progress)
}

function capture(card, location) {
    const phases = floatingPhases(card.closest('.floating-print-wall'))
    const current = touchMotion() ? null : readTitleStyle(cardPose(card))
    const pose = current && { frame: current.frame, clipped: current.clipped, clip: current.clip, edge: current.edge,
        inlineBounds: current.inlineBounds, title: current.title }
    return { from: location, marker: card.dataset.routeCard, path: cardPath(card), pose, phases,
        inMain: mainPage()?.contains(card), scrollY: window.scrollY,
        navbarVisible: navbar()?.hasAttribute('data-navbar-visible') }
}

function returnedCard(main, record) {
    if (!record?.pose) return null
    let closest = null
    let distance = Infinity
    const cards = `[data-route-card=${CSS.escape(record.marker)}]:is([href=${CSS.escape(record.path)}], [data-route-target=${CSS.escape(record.path)}])`
    for (const card of main.querySelectorAll(cards)) {
        const pose = cardPose(card)
        if (!pose) continue
        const shift = Math.hypot(pose.frame.left - record.pose.frame.left, pose.frame.top - record.pose.frame.top)
        if (shift < distance) {
            closest = pose
            distance = shift
        }
    }
    return closest
}

function scrollPoseReady(card) {
    if (!card?.matches('.album-card.editorial-motion-media')
        || !CSS.supports('animation-timeline', 'scroll(root block)') || !CSS.supports('animation-range', '0px 1px')) return true
    // A scroll timeline can be attached one frame before it samples a
    // restored position. Measure the card only after that pose is painted.
    return card.classList.contains('editorial-timeline') && getComputedStyle(card).transform !== 'none'
}

function holdFloatingTracks(phases) {
    const wall = mainPage()?.querySelector('.floating-print-wall')
    const tracks = wall?.querySelectorAll(floatingTracks)
    if (!tracks?.length) return undefined
    wall.dataset.routeCardHold = ''
    tracks.forEach((track, index) => {
        const animation = track.getAnimations()[0]
        if (animation && Number.isFinite(phases[index])) {
            animation.currentTime = animation.effect.getTiming().duration * phases[index]
        }
    })
    return () => { delete wall.dataset.routeCardHold }
}

const cardTravelMs = 330
const albumCardTravelMs = 285
const clippedTravelMs = 370
const floatingTravelMs = 320
const outlineFadeMs = 130
const pageRevealMs = 355
const pageRevealDelayMs = 270
const cardReturnTravelMs = 245
const pageReturnMs = 350
const titleHandoffMs = 140
const albumCardMarkers = new Set(['album', 'calendar', 'timeline', 'floating'])
const moduleCardMarkers = new Set(['app', 'explore'])

const returnReveal = { duration: pageReturnMs, delay: 0, fill: 'both', easing: 'ease-out' }
const stagedReveal = { duration: pageRevealMs, delay: pageRevealDelayMs, fill: 'both', easing: 'ease-in-out' }
const moduleReturnReveal = { ...returnReveal, duration: 420 }
const clippedEntryReveal = { ...stagedReveal, delay: 165 }
const clippedReturnReveal = { ...returnReveal, duration: 455 }
const floatingEntryReveal = { ...clippedEntryReveal, delay: 90 }
const floatingReturnReveal = { ...clippedReturnReveal, duration: 400 }
const routeReveal = { duration: 390, fill: 'backwards', easing: 'ease-in-out' }
const previewLandingMs = 175
const previewReveal = { ...stagedReveal, delay: previewLandingMs, duration: 320 }

function holdNavbarForReturn(visible) {
    const nav = navbar()
    if (!nav || visible === undefined) return undefined
    const syncVisibility = () => nav.dispatchEvent(new Event('route-card-navbar-restore'))
    // Scroll restoration can look like a new downward scroll to the masthead.
    // Keep the saved pose until the restored page and moving title are settled.
    nav.dataset.routeCardNavbar = visible ? 'shown' : 'hidden'
    syncVisibility()
    return () => {
        syncVisibility()
        delete nav.dataset.routeCardNavbar
    }
}

function titleLayer(layer, pose) {
    const label = document.createElement('span')
    label.className = 'route-card-title'
    label.textContent = pose.text
    Object.assign(label.style, pose.style)
    label.style.transform = titleTransform(pose, pose.rect)
    layer.append(label)
    return label
}

function titleTransform(pose, rect, ratio = 1) {
    const scaleX = rect.width / pose.layoutWidth * ratio
    const scaleY = rect.height / pose.layoutHeight * ratio
    return `translate(${rect.left}px, ${rect.top}px) scale(${scaleX}, ${scaleY})`
}

function landingTransform({ element, title }) {
    const { rect, layoutWidth, layoutHeight } = title
    let matrix = new DOMMatrix()
    for (let node = element; node && node.id !== 'main-content'; node = node.parentElement) {
        const { transform, scale } = getComputedStyle(node)
        if (transform !== 'none') matrix = new DOMMatrix(transform).multiply(matrix)
        if (scale && scale !== 'none') {
            const [x, y = x] = scale.split(' ').map(value => parseFloat(value) / (value.endsWith('%') ? 100 : 1))
            matrix = new DOMMatrix().scale(x, y).multiply(matrix)
        }
    }
    const { a, b, c, d } = matrix
    // An axis-aligned rectangle includes the extra width and height created
    // by rotation. Reconstruct the text's real pose from the transformed axes.
    const width = Math.abs(a) * layoutWidth + Math.abs(c) * layoutHeight
    const height = Math.abs(b) * layoutWidth + Math.abs(d) * layoutHeight
    if (matrix.m14 || matrix.m24 || Math.abs(width - rect.width) > .3 || Math.abs(height - rect.height) > .3) {
        return titleTransform(title, rect)
    }
    const x = rect.left - Math.min(0, a * layoutWidth) - Math.min(0, c * layoutHeight)
    const y = rect.top - Math.min(0, b * layoutWidth) - Math.min(0, d * layoutHeight)
    return `translate(${x}px, ${y}px) matrix(${a}, ${b}, ${c}, ${d}, 0, 0)`
}

function alignedTitleTransform(copy, to) {
    const transform = landingTransform(to)
    copy.style.transform = transform
    const range = document.createRange()
    range.selectNodeContents(to.element)
    const live = range.getClientRects()[0]
    range.selectNodeContents(copy)
    const duplicate = range.getClientRects()[0]
    if (!live || !duplicate) return transform
    const x = live.left - duplicate.left
    const y = live.top - duplicate.top
    return Math.abs(x) <= 2 && Math.abs(y) <= 2
        ? `translate(${x}px, ${y}px) ${transform}`
        : transform
}

function copyTitleAnchor(copy, pose) {
    const range = document.createRange()
    const text = copy.firstChild
    const [first] = pose.text
    range.setStart(text, 0)
    range.setEnd(text, first.length)
    const glyph = range.getBoundingClientRect()
    if (!glyph.width || !glyph.height) return null
    // Copies are initially translated and scaled to their own title boxes.
    const { rect, layoutWidth, layoutHeight } = pose
    return new DOMPoint((glyph.left - rect.left) * layoutWidth / rect.width,
        (glyph.top - rect.top) * layoutHeight / rect.height)
}

function alignTitleTravel(label, sourceAnchor, source, target, targetAnchor, destination) {
    const sourceMatrices = source.map(frame => new DOMMatrix(frame.transform))
    const targetMatrices = destination.map(frame => new DOMMatrix(frame.transform))
    const path = [sourceAnchor.matrixTransform(sourceMatrices[0]), targetAnchor.matrixTransform(targetMatrices[1])]
    // Different line wraps and line heights put the glyphs at different
    // offsets inside the two boxes. Move both from the same text anchor.
    for (const [copy, anchor, frames, matrices] of [
        [label, sourceAnchor, source, sourceMatrices], [target, targetAnchor, destination, targetMatrices],
    ]) {
        copy.style.transformOrigin = `${anchor.x}px ${anchor.y}px`
        frames.forEach((frame, index) => {
            const { x, y } = path[index]
            const { a, b, c, d } = matrices[index]
            frame.transform = `translate(${x - anchor.x}px, ${y - anchor.y}px) matrix(${a}, ${b}, ${c}, ${d}, 0, 0)`
        })
    }
}

function outlineTransform(from, to) {
    return `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${to.width / from.width}, ${to.height / from.height})`
}

function holdCardHover(card) {
    if (!card?.matches('.album-card, .floating-print-card, .photo-stats-timeline-card, .explore-module-card')) return undefined
    card.dataset.routeCardResting = ''
    let x
    let y
    const track = event => {
        x = event.clientX
        y = event.clientY
    }
    window.addEventListener('pointermove', track, { passive: true })
    card.addEventListener('pointerenter', track)
    const reset = () => {
        delete card.dataset.routeCardResting
        card.removeEventListener('pointermove', move)
        card.removeEventListener('pointerleave', reset)
    }
    const move = event => {
        const moved = x !== undefined && (event.clientX !== x || event.clientY !== y)
        if (moved || event.movementX || event.movementY || event.pointerType !== 'mouse') reset()
        else track(event)
    }
    return () => {
        window.removeEventListener('pointermove', track)
        card.removeEventListener('pointerenter', track)
        // Browsers can update :hover after the handoff finishes with the
        // pointer still in place. Resume tilt on actual movement.
        card.addEventListener('pointermove', move)
        card.addEventListener('pointerleave', reset)
    }
}

function handoffTitle(target, outgoing, live, reveal) {
    const shortHandoff = reveal === clippedReturnReveal || reveal === floatingEntryReveal
        || reveal === floatingReturnReveal || reveal === moduleReturnReveal
    const early = reveal === returnReveal
    const duration = shortHandoff ? 40 : early ? 44 : 70
    const lead = shortHandoff ? 34 : early ? 48 : 64
    // Match the page's opacity at the exchange so the lettering keeps its contrast.
    const handoff = target.animate([{ opacity: 1 }, { opacity: shortHandoff ? .99 : early ? .965 : .94 }], {
        delay: reveal.delay + reveal.duration - lead - duration,
        duration, fill: 'forwards', easing: 'ease-in-out',
    })
    handoff.finished.then(() => {
        outgoing?.remove()
        target.remove()
        live.removeAttribute('data-route-title-landing')
    }, () => {})
    return handoff
}

function animateTitles(layer, label, from, to, timing, reveal, atomicHandoff, clipped, preserveInk) {
    const destination = to.title
    const target = titleLayer(layer, destination)
    const sourceAnchor = from.text === destination.text ? copyTitleAnchor(label, from) : null
    const targetAnchor = sourceAnchor && copyTitleAnchor(target, destination)
    const scale = Number.parseFloat(destination.style.fontSize) / Number.parseFloat(from.style.fontSize)
    const sourceStart = titleTransform(from, from.rect)
    const sourceEnd = titleTransform(destination, destination.rect, scale)
    const targetStart = titleTransform(from, from.rect, 1 / scale)
    const targetEnd = atomicHandoff ? alignedTitleTransform(target, to) : landingTransform(to)
    const sourceTravel = [{ transform: sourceStart }, { transform: sourceEnd }]
    const targetTravel = [{ transform: targetStart }, { transform: targetEnd }]
    if (sourceAnchor && targetAnchor) alignTitleTravel(label, sourceAnchor, sourceTravel, target, targetAnchor, targetTravel)
    const alpha = [0, .35, .75, 1].map((offset, index) => ({ opacity: Number(index >= 2), offset }))
    const motion = [
        label.animate(sourceTravel, timing),
        target.animate(targetTravel, timing),
        label.animate(alpha.map(({ opacity, offset }) => ({ opacity: 1 - opacity, offset })), timing),
        target.animate(alpha, timing),
    ]
    if (clipped) {
        const clip = [from, destination].map(pose => ({ clipPath: titleClip(pose.crop, preserveInk) }))
        motion.push(label.animate(clip, timing), target.animate(clip, timing))
    }
    if (!reveal) return { motions: motion }
    if (atomicHandoff) {
        if (from.style.color !== destination.style.color) {
            motion.push(label.animate([{ color: from.style.color }, { color: destination.style.color }], {
                duration: 110, fill: 'forwards', easing: 'ease-out',
            }))
        }
        const handoffCopy = handoffTitle(target, label, to.element, reveal)
        return { motions: [...motion, handoffCopy], handoff: handoffCopy.finished }
    }
    const handoff = {
        duration: titleHandoffMs,
        delay: reveal.delay + reveal.duration - titleHandoffMs,
        easing: 'ease-in-out',
    }
    const copyExit = target.animate([{ opacity: 1 }, { opacity: 1, offset: .4 }, { opacity: 0 }], { ...handoff, fill: 'forwards' })
    const liveEnter = to.element.animate([{ opacity: 0 }, { opacity: 1, offset: .65 }, { opacity: 1 }], { ...handoff, fill: 'both' })
    return { motions: [...motion, copyExit, liveEnter] }
}

function animateEdgeTitle(titleWindow, label, heading, card, returning, travel, reveal) {
    const title = heading.title
    const copy = label ?? titleLayer(titleWindow, title)
    const scale = .56
    const { width, height } = title.rect
    const { frame, edge } = card
    const aligned = (start, visible, size, direction) => start + (visible - size * scale) * (1 - direction) / 2
    const tucked = titleTransform(title, { width, height,
        left: aligned(frame.left, frame.width, width, edge.x),
        top: aligned(frame.top, frame.height, height, edge.y) }, scale)
    const shown = returning ? titleTransform(title, title.rect) : alignedTitleTransform(copy, heading)
    const poses = returning ? [shown, tucked] : [tucked, shown]
    const fade = returning ? [{ opacity: 1 }, { opacity: .9, offset: .24 }, { opacity: 0, offset: .86 }, { opacity: 0 }]
        : [{ opacity: 0 }, { opacity: reveal === floatingEntryReveal ? .3 : 0, offset: .12 }, { opacity: 1, offset: .76 }, { opacity: 1 }]
    const motions = [copy.animate(poses.map(transform => ({ transform })), travel), copy.animate(fade, { ...travel, easing: 'linear' })]
    if (returning) return { motions }
    const handoff = handoffTitle(copy, null, heading.element, reveal)
    return { motions: [...motions, handoff], handoff: handoff.finished }
}

function stageCard(main, from, returning, record) {
    const layer = document.createElement('div')
    layer.dataset.routeCardMorph = ''
    layer.setAttribute('aria-hidden', 'true')
    layer.inert = true
    const { marker } = record
    const albumMorph = albumCardMarkers.has(marker)
    const earlyReturn = returning && (albumMorph || marker === 'section')
    const moduleReturn = returning && moduleCardMarkers.has(marker)
    const wasClipped = albumMorph && record.pose.clipped
    const isClipped = to => wasClipped || (albumMorph && to?.clipped)
    // A card can extend past the bottom of the viewport with its whole title
    // still on screen. The row's top edge must not cut into that title as it rises.
    const clearBottomTitle = !returning && marker === 'album' && from.edge?.y === 1 && from.edge.x === 0
        && from.title && !from.title.crop
    const outline = marker === 'section' || wasClipped || moduleReturn ? null : document.createElement('div')
    if (outline) {
        outline.className = 'route-card-outline'
        Object.assign(outline.style, geometry(from.frame), { opacity: '0' })
        layer.append(outline)
    }
    const titles = document.createElement('div')
    titles.className = 'route-card-title-window'
    if (wasClipped && !returning && !clearBottomTitle) titles.style.clipPath = from.clip
    layer.append(titles)
    let label = from.title ? titleLayer(titles, from.title) : null
    main.dataset.routePageStaged = ''
    if (returning) main.dataset.routePageReturning = ''
    main.parentElement.append(layer)
    const animations = []
    const edgeTiming = { duration: outlineFadeMs, fill: 'both', easing: 'ease-out' }
    if (outline && !returning) animations.push(outline.animate([{ opacity: .36 }, { opacity: 0 }], edgeTiming))
    let resumeHover
    let interactiveTimer
    let previewHeading
    let previewPose
    return {
        get previewMoving() { return Boolean(previewHeading && !previewPose) },
        get hasPreview() { return Boolean(previewPose) },
        showPreview() {
            if (previewHeading || !label) return
            // Start the flight into an album header while the route still loads.
            // Keep its landing separate from the real heading until that exists.
            const preview = document.createElement('div')
            preview.className = 'route-card-preview linen-gallery-header max-w-7xl px-6'
            if (record.path.startsWith('/video/')) preview.dataset.routeCardVideo = ''
            const heading = document.createElement('h1')
            heading.className = 'font-serif text-4xl md:text-5xl font-semibold text-charcoal mb-4 w-fit'
            heading.textContent = from.title.text
            heading.dataset.routeTitleLanding = ''
            preview.append(heading)
            layer.prepend(preview)
            const landing = readTitleStyle(headingPose(heading))
            if (!landing?.title) {
                preview.remove()
                return
            }
            previewHeading = heading
            const travel = { duration: 245, fill: 'both', easing: albumEasing }
            const clipped = wasClipped && !clearBottomTitle
            const { motions } = animateTitles(titles, label, from.title, landing, travel, null, true, clipped, false)
            if (clipped) motions.push(titles.animate([{ clipPath: from.clip }, { clipPath: openClip }], travel))
            animations.push(...motions)
            Promise.allSettled(motions.map(animation => animation.finished)).then(() => {
                if (!layer.isConnected) return
                previewPose = landing
                titles.replaceChildren()
                titles.style.clipPath = ''
                motions.forEach(animation => animation.cancel())
                delete heading.dataset.routeTitleLanding
            })
        },
        reveal(to) {
            if (previewPose) return previewReveal
            if (isClipped(to)) {
                if (marker === 'floating') return returning ? floatingReturnReveal : floatingEntryReveal
                return returning ? clippedReturnReveal : clippedEntryReveal
            }
            return moduleReturn ? moduleReturnReveal : earlyReturn ? returnReveal : stagedReveal
        },
        play(to, reveal) {
            const parked = previewPose && readTitleStyle(headingPose(previewHeading))
            const departure = parked?.title ? parked : previewPose || from
            if (previewPose) {
                label = titleLayer(titles, departure.title)
                previewHeading.dataset.routeTitleLanding = ''
                outline?.remove()
            }
            const clipped = !previewPose && isClipped(to)
            const floating = clipped && marker === 'floating'
            const duration = previewPose ? previewLandingMs : floating ? floatingTravelMs : clipped ? clippedTravelMs
                : earlyReturn ? cardReturnTravelMs : albumMorph ? albumCardTravelMs : cardTravelMs
            const travel = { duration, fill: 'both', easing: floating ? floatingEasing : clipped ? clippedEasing : albumMorph ? albumEasing : easing }
            const matchingTitle = label && matchingTitles(departure.title, to?.title) && to.element
            const croppedCard = returning ? to : previewPose ? null : from
            const bounds = floating && croppedCard?.inlineBounds
            const headingBounds = (returning ? from : to)?.title?.rect
            const fixedClip = bounds && headingBounds && headingBounds.left >= bounds.left && headingBounds.right <= bounds.right
            if (fixedClip) titles.style.clipPath = croppedCard.clip
            else if (croppedCard?.clipped && !clearBottomTitle) {
                // Keep the letters inside the actual row while they leave or
                // approach its edge. The glyph clip alone moves with the copy.
                const crop = { clipPath: croppedCard.clip }
                const open = { clipPath: openClip }
                const frames = returning ? [open, { ...open, offset: .2 }, { ...crop, offset: .62 }, crop]
                    : [crop, { ...crop, offset: .38 }, { ...open, offset: .8 }, open]
                animations.push(titles.animate(frames, { ...travel, easing: 'linear' }))
            }
            let handoff
            if (outline && to && !previewPose) {
                if (clipped) outline.remove()
                else {
                    animations.push(outline.animate([{ transform: 'translate(0px, 0px) scale(1, 1)' },
                        { transform: outlineTransform(from.frame, to.frame) }], travel))
                    if (returning) animations.push(outline.animate(
                        [{ opacity: 0 }, { opacity: .25, offset: .24 }, { opacity: 0 }], edgeTiming))
                }
            }
            if (matchingTitle) {
                resumeHover = holdCardHover(to.card)
                const preserveInk = marker === 'timeline' && Boolean(croppedCard?.inlineBounds)
                const title = animateTitles(titles, label, departure.title, to, travel, reveal, albumMorph || earlyReturn || moduleReturn,
                    clipped && !fixedClip && !clearBottomTitle, preserveInk)
                animations.push(...title.motions)
                handoff = title.handoff
            } else if (albumMorph && croppedCard?.edge && to) {
                resumeHover = holdCardHover(to.card)
                const title = animateEdgeTitle(titles, label, returning ? from : to, croppedCard, returning, travel, reveal)
                animations.push(...title.motions)
                handoff = title.handoff
            } else if (label) animations.push(label.animate([{ opacity: 1 }, { opacity: 0 }], { ...reveal, easing: 'ease-out' }))
            const interactiveDelay = to && (albumMorph || earlyReturn || moduleReturn) ? Math.max(reveal.delay, travel.duration) : reveal.delay
            interactiveTimer = window.setTimeout(() => { main.dataset.routePageRevealing = '' }, interactiveDelay)
            return handoff
        },
        remove() {
            clearTimeout(interactiveTimer)
            delete main.dataset.routePageStaged
            delete main.dataset.routePageReturning
            delete main.dataset.routePageRevealing
            layer.remove()
            animations.forEach(animation => animation.cancel())
            resumeHover?.()
        },
    }
}

function revealPage(main, { returning, stage, landing, onFinish, fromOpacity = 0, timing = routeReveal }) {
    const stagedTiming = stage?.reveal(landing)
    const options = stage ? (landing ? stagedTiming : { ...stagedTiming, delay: 0 }) : timing
    const frames = [{ opacity: fromOpacity }, { opacity: 1 }]
    const motion = main.animate(frames, options)
    const handoff = stage?.play(landing, options)
    const footer = main.parentElement.querySelector(':scope > footer')?.animate(frames, options)
    main.dataset.routePageMotion = returning ? 'return' : 'enter'
    let finished = false
    const release = () => {
        if (finished) return
        finished = true
        stage?.remove()
        motion.cancel()
        footer?.cancel()
        delete main.dataset.routePageMotion
        onFinish?.()
    }
    // If the browser skips a frame near the end, let the title finish its
    // handoff before removing the layer and clearing the live title.
    Promise.allSettled([motion.finished, handoff]).then(release)
    return release
}

function revealTouchPage(main, returning, onFinish) {
    const veil = document.createElement('div')
    veil.className = 'route-page-touch-fade'
    veil.setAttribute('aria-hidden', 'true')
    main.after(veil)
    const timing = { duration: 320, easing: 'ease-in-out', fill: 'both' }
    const motion = veil.animate([{ opacity: .92 }, { opacity: 0 }], timing)
    const heading = returning ? null : main.querySelector('.linen-gallery-header h1')
    const rise = heading?.animate([{ transform: 'translateY(10px)' }, { transform: 'translateY(0px)' }], timing)
    main.dataset.routePageMotion = returning ? 'return' : 'enter'
    let finished = false
    const stop = () => {
        if (finished) return
        finished = true
        veil.remove()
        motion.cancel()
        rise?.cancel()
        delete main.dataset.routePageMotion
        onFinish()
    }
    motion.finished.then(stop, () => {})
    return stop
}

function fadeRoute({ returning, onFinish, timing, phases, destination }) {
    const main = mainPage()
    if (!main || !motionAllowed()) return
    let frame
    let release
    let resumeTracks
    const finish = () => {
        resumeTracks?.()
        resumeTracks = undefined
        onFinish?.()
    }
    const prepare = () => {
        const page = main.firstElementChild
        page?.setAttribute('data-route-faded', returning ? 'return' : '')
        if (touchMotion()) {
            if (phases) resumeTracks = holdFloatingTracks(phases)
            release = revealTouchPage(main, returning, finish)
            return
        }
        main.dataset.routePagePreparing = ''
        const started = performance.now()
        const fade = () => {
            if (document.fonts?.status === 'loading' && performance.now() - started < 160) {
                frame = requestAnimationFrame(fade)
                return
            }
            delete main.dataset.routePagePreparing
            if (motionAllowed()) {
                if (phases) resumeTracks = holdFloatingTracks(phases)
                release = revealPage(main, { returning, onFinish: finish, timing })
            } else finish()
        }
        // The restored viewport and newly mounted styles get a paint before
        // the destination text becomes visible.
        frame = requestAnimationFrame(() => { frame = requestAnimationFrame(fade) })
    }
    // Suspense can keep the old page painted after the URL changes. Start a
    // phone fade only after the destination has committed and left its loader.
    const ready = () => {
        if (main.querySelector('[data-route-loading]')) return false
        const path = destination?.()
        if (!path) return true
        if (main.querySelector('[data-route-content]')?.dataset.routeContent !== path) return false
        return !/^\/(album|video)\//.test(path) || main.querySelector('.linen-gallery-header h1, [data-route-gallery-error]')
    }
    let observer
    if (!ready()) {
        observer = new MutationObserver(() => {
            if (!ready()) return
            observer.disconnect()
            if (motionAllowed()) prepare()
        })
        observer.observe(main, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-route-content', 'data-route-loading'] })
    } else prepare()
    return () => {
        observer?.disconnect()
        cancelAnimationFrame(frame)
        delete main.dataset.routePagePreparing
        if (release) release()
        else finish()
    }
}

export default function RouteCardMotion() {
    const location = useLocation()
    const action = useNavigationType()
    const state = useRef({ location, history: new Map() })

    useLayoutEffect(() => {
        const runtime = state.current
        const render = (record, returning, inline = false) => {
            runtime.stop?.()
            if (!motionAllowed()) return
            const main = mainPage()
            if (!main) return
            const albumMorph = albumCardMarkers.has(record?.marker)
            const from = returning ? (record?.inMain && record.pose && record.heading) : record?.pose
            const canStage = from?.title || (!returning && albumMorph && from?.edge)
            const opensPlayer = !returning && record?.path.endsWith('?play=1')
            const restoreGallery = returning && (albumMorph || record?.marker === 'section')
            const releaseNavbar = restoreGallery ? holdNavbarForReturn(record.navbarVisible) : undefined
            const fastReturn = restoreGallery || (returning && moduleCardMarkers.has(record?.marker))
            const timing = fastReturn ? returnReveal : routeReveal
            const touch = touchMotion()
            if (touch || (!canStage && !inline)) {
                runtime.stop = fadeRoute({
                    returning, onFinish: releaseNavbar, timing, phases: returning ? record?.phases : undefined,
                    destination: touch && !inline ? () => runtime.location.pathname : undefined,
                })
                return
            }
            const stage = canStage && !opensPlayer ? stageCard(main, from, returning, record) : null
            const waitForAlbum = stage && albumMorph && !inline
            let frame
            let release
            let resumeTracks
            let stagedTitle
            let previousFrame
            let fontElement
            let titleFont
            let landingScroll
            let loadingObserver
            let loadingTimer
            let started = performance.now()
            const settleMs = returning ? 50 : record?.marker === 'floating' && from?.clipped ? 34 : 72
            const interruption = stage && returning ? new AbortController() : null
            const clearTitle = () => stagedTitle?.removeAttribute('data-route-title-landing')
            const clearLoading = () => {
                loadingObserver?.disconnect()
                loadingObserver = undefined
                clearTimeout(loadingTimer)
            }
            const cleanup = () => {
                interruption?.abort()
                clearLoading()
                clearTitle()
                resumeTracks?.()
                releaseNavbar?.()
            }
            const stop = () => {
                cancelAnimationFrame(frame)
                if (release) release()
                else {
                    stage?.remove()
                    cleanup()
                }
            }
            if (interruption) {
                const touchViewport = window.matchMedia('(pointer: coarse)').matches
                const viewportWidth = window.innerWidth
                const cancelMorph = () => {
                    const opacity = Math.max(.68, Number(getComputedStyle(main).opacity))
                    stop()
                    runtime.stop = revealPage(main, { returning: true, fromOpacity: opacity, timing: { ...routeReveal, duration: 150 } })
                }
                const listener = { signal: interruption.signal, passive: true }
                window.addEventListener('wheel', event => {
                    if (Math.abs(event.deltaY) > Math.abs(event.deltaX) && !event.ctrlKey) cancelMorph()
                }, listener)
                watchTouchScroll(cancelMorph, interruption.signal)
                window.addEventListener('keydown', event => {
                    if (!event.defaultPrevented && ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)
                        && !event.target?.closest?.('button, input, textarea, select, [contenteditable], [role="combobox"]')) cancelMorph()
                }, listener)
                window.addEventListener('scroll', () => {
                    if (!landingScroll || (touchViewport && document.documentElement.hasAttribute('data-route-scroll-restoring'))) return
                    const { x, y, row, left } = landingScroll
                    if (Math.abs(scrollX - x) > 1 || Math.abs(scrollY - y) > 1 || (row && Math.abs(row.scrollLeft - left) > 1)) cancelMorph()
                }, { ...listener, capture: true })
                window.addEventListener('resize', () => {
                    // Mobile browser chrome can change the height as Back
                    // completes without invalidating the card's layout.
                    if (!touchViewport || window.innerWidth !== viewportWidth) cancelMorph()
                }, listener)
            }
            const step = () => {
                frame = undefined
                const page = main.firstElementChild
                if (returning && page && page.getAttribute('data-route-faded') !== 'return') page.setAttribute('data-route-faded', 'return')
                const committed = !waitForAlbum || main.querySelector('[data-route-content]')?.dataset.routeContent === runtime.location.pathname
                const ready = committed && (!inline || Boolean(main.querySelector('[data-inline-album]')) !== returning)
                const restored = !returning || !record || Math.abs(window.scrollY - record.scrollY) <= 3
                if (returning && restored && record?.phases && !resumeTracks) resumeTracks = holdFloatingTracks(record.phases)
                const to = ready && restored && record?.pose
                    ? returning ? returnedCard(main, record) : headingPose(main.querySelector(
                        inline ? '[data-inline-album] h2' : waitForAlbum ? '.linen-gallery-header h1' : 'h1',
                    ))
                    : null
                if (waitForAlbum && !to && (page?.hasAttribute('data-route-loading') || (committed && page?.getAttribute('aria-busy') === 'true'))) {
                    if (!loadingObserver) {
                        // Let the title reach the header during a slow open.
                        if (!returning) loadingTimer = window.setTimeout(stage.showPreview, 180)
                        loadingObserver = new MutationObserver(step)
                        loadingObserver.observe(main, { childList: true, subtree: true, attributes: true,
                            attributeFilter: ['aria-busy', 'data-route-content', 'data-route-loading'] })
                    }
                    return
                }
                if (loadingObserver) {
                    clearLoading()
                    started = performance.now()
                    previousFrame = undefined
                }
                if (stage?.previewMoving) {
                    frame = requestAnimationFrame(step)
                    return
                }
                const elapsed = performance.now() - started
                const matches = matchingTitles(from?.title, to?.title)
                const edgeMorph = stage && albumMorph && (returning ? to?.edge && from.title : from.edge && to?.title)
                const title = stage && (matches || (!returning && edgeMorph)) ? to.element : null
                if (stagedTitle !== title) {
                    clearTitle()
                    stagedTitle = title
                    if (title) title.dataset.routeTitleLanding = ''
                }
                const target = to?.title?.rect ?? (albumMorph ? to?.frame : null)
                let stable = elapsed >= settleMs && target && previousFrame
                    && (!returning || scrollPoseReady(to?.card))
                    && ['left', 'top', 'width', 'height'].every(key => Math.abs(target[key] - previousFrame[key]) < .3)
                if (stable && to?.title && document.fonts?.status === 'loading') {
                    // Body or icon fonts can still be loading when the heading
                    // is ready. Measure only the face that owns the handoff.
                    if (fontElement !== to.element) {
                        fontElement = to.element
                        const { fontStyle, fontWeight, fontSize, fontFamily } = getComputedStyle(fontElement)
                        titleFont = `${fontStyle} ${fontWeight} ${fontSize} ${fontFamily}`
                    }
                    stable = document.fonts.check(titleFont, to.title.text)
                }
                previousFrame = target
                const expired = elapsed >= (target ? 650 : 420)
                if (ready && (stable || !from || expired)) {
                    // While the destination settles, measure only geometry. Match
                    // its typography once, at the exact pose used for the handoff.
                    const settled = stable ? readTitleStyle(to) : null
                    if (!returning && settled) record.heading = { frame: settled.frame, title: settled.title }
                    const landing = title || edgeMorph ? settled : null
                    if (!landing) clearTitle()
                    if (stage && !landing && albumMorph && !stage.hasPreview) {
                        stage.remove()
                        release = revealPage(main, { returning, onFinish: cleanup, timing })
                        return
                    }
                    if (interruption) {
                        const row = landing?.card?.closest('[data-scroll-row], .photo-stats-timeline-scroll')
                        landingScroll = { x: scrollX, y: scrollY, row, left: row?.scrollLeft }
                    }
                    release = revealPage(main, { returning, stage, landing, onFinish: cleanup, timing })
                } else if (elapsed < 650) frame = requestAnimationFrame(step)
                else stop()
            }
            frame = requestAnimationFrame(step)
            runtime.stop = stop
        }
        runtime.render = render
        const queue = (record, returning, path) => {
            runtime.pending = { record, returning, path, time: performance.now() }
        }
        const rememberHeading = (record) => {
            if (!record || touchMotion()) return
            const heading = readTitleStyle(headingPose(mainPage()?.querySelector('[data-inline-album] h2, h1')))
            record.heading = heading ? { frame: heading.frame, title: heading.title } : undefined
        }
        const pop = () => {
            if (!motionAllowed()) return
            rememberHeading(runtime.history.get(runtime.location.key))
            const key = window.history.state?.key
            const next = runtime.history.get(key)
            const main = mainPage()
            if (main && next?.marker === 'floating' && next.from.key === runtime.location.key) {
                if (touchMotion()) {
                    next.phases = floatingPhases(main.querySelector('.floating-print-wall'))
                    return
                }
                const card = returnedCard(main, next)?.card
                const current = card && capture(card, runtime.location)
                if (current?.pose) runtime.history.set(key, current)
            }
        }
        const click = event => {
            if (!motionAllowed() || event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey
                || event.metaKey || event.shiftKey || !(event.target instanceof Element)) return
            const card = event.target.closest('[data-route-card]')
            const link = event.target.closest('a[href]')
            if (link && (link.origin !== window.location.origin || link.target && link.target !== '_self' || link.hasAttribute('download'))) return
            if (card) {
                const record = capture(card, runtime.location)
                if (card.hasAttribute('data-route-inline')) {
                    runtime.inline = record
                    render(record, false, true)
                } else {
                    const path = card.dataset.routeTarget || (link && link.pathname + link.search)
                    if (path && path !== pathOf(runtime.location)) queue(record, false, path)
                }
            } else if (event.target.closest('[data-inline-album-back]')) {
                rememberHeading(runtime.inline)
                render(runtime.inline, true, true)
                runtime.inline = undefined
            } else if (link?.matches('.explore-back, .linen-gallery-back')) {
                const record = runtime.history.get(runtime.location.key)
                const path = link.pathname + link.search
                if (record && path === pathOf(record.from)) {
                    rememberHeading(record)
                    queue(record, true, path)
                }
                else queue(undefined, true, path)
            } else if (event.target.closest('.linen-gallery-back')) {
                const record = runtime.history.get(runtime.location.key)
                rememberHeading(record)
                queue(record, true)
            }
        }
        document.addEventListener('click', click, true)
        window.addEventListener('popstate', pop, true)
        return () => {
            document.removeEventListener('click', click, true)
            window.removeEventListener('popstate', pop, true)
            runtime.stop?.()
        }
    }, [])

    useLayoutEffect(() => {
        const runtime = state.current
        const prior = runtime.location
        runtime.location = location
        if (location.key === prior.key) return
        const pending = runtime.pending
        const from = runtime.history.get(prior.key)
        const to = runtime.history.get(location.key)
        runtime.pending = undefined
        if (pending && performance.now() - pending.time < 1500
            && (!pending.path || pending.path === pathOf(location))) {
            if (!pending.returning) runtime.history.set(location.key, pending.record)
            runtime.render(pending.record, pending.returning)
        } else if (action === 'POP' && from?.from.key === location.key) {
            runtime.render(from, true)
        } else if (action === 'POP' && to?.from.key === prior.key) {
            runtime.render(to, false)
        } else if (action === 'REPLACE' && from) {
            runtime.history.set(location.key, from)
            runtime.history.delete(prior.key)
        } else if (location.pathname !== prior.pathname) {
            runtime.stop?.()
            runtime.stop = fadeRoute({ returning: action === 'POP', destination: touchMotion() ? () => runtime.location.pathname : undefined })
        }
        if (location.pathname !== prior.pathname) runtime.inline = undefined
        if (runtime.history.size > 32) runtime.history.delete(runtime.history.keys().next().value)
    }, [location, action])

    return null
}
