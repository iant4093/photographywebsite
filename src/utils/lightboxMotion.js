import { findLightboxReturn, lightboxRect, prefersReducedLightboxMotion, takeLightboxTrigger } from './lightboxOrigin'
import { lightboxMotionControllers } from './lightboxMotionControl'

const photoFrame = '.linen-lightbox-photo-frame.is-loaded:not(.is-hidden, .is-outgoing)'
const controls = '.linen-lightbox-previous, .linen-lightbox-next, .linen-lightbox-metadata, .linen-lightbox-actions, .site-video-controls'
const panelEdges = '.museum-album-toolbar, .museum-album-footer, .section-stats-close'
const labelSelector = '[data-lightbox-label]'
const qrSelector = '[data-lightbox-qr]'
const ease = 'cubic-bezier(.22,.68,.25,1)'
const reversePanelEase = 'cubic-bezier(.45,0,.28,1)'
const clear = 'rgba(0, 0, 0, 0)'

function shape(rect, style, backgroundColor, boxShadow = style.boxShadow) {
    return {
        left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
        borderRadius: style.borderRadius, backgroundColor, boxShadow,
    }
}

function insetBorder(style) {
    const border = `inset 0 0 0 ${style.borderTopWidth} ${style.borderTopColor}`
    return style.boxShadow === 'none' ? border : `${border}, ${style.boxShadow}`
}

function clipTo(rect, frame) {
    return `inset(${frame.top - rect.top}px ${rect.right - frame.right}px ${rect.bottom - frame.bottom}px ${frame.left - rect.left}px)`
}

function labelStyle(style) {
    return { color: style.color, fontSize: style.fontSize, lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing === 'normal' ? '0px' : style.letterSpacing }
}

function labelPose(element, frame) {
    const rect = element.getBoundingClientRect()
    return { left: `${rect.left - frame.left}px`, top: `${rect.top - frame.top}px`, ...labelStyle(getComputedStyle(element)) }
}

function getTarget(dialog, kind) {
    if (kind === 'photo') return dialog.querySelector(photoFrame)
    if (kind === 'video') return dialog.querySelector('.site-video-player > video')
    return dialog.querySelector('[data-lightbox-panel]')
}

function makeFlight(dialog, origin, src, panel) {
    const shell = document.createElement('div')
    shell.className = panel ? 'lightbox-motion-flight lightbox-motion-panel-flight' : 'lightbox-motion-flight'
    shell.setAttribute('aria-hidden', 'true')
    const image = src ? new Image() : null
    if (image) {
        image.alt = ''
        image.src = src
        shell.append(image)
    }
    const button = origin.kind === 'button' || origin.kind === 'panel'
    const label = button && origin.element ? document.createElement('span') : null
    if (label) {
        const style = getComputedStyle(origin.element)
        const children = [...origin.element.childNodes]
        label.replaceChildren(...children.map(child => child.cloneNode(true)))
        Object.assign(label.style, {
            font: style.font, color: style.color, letterSpacing: style.letterSpacing, gap: style.gap,
            paddingInlineStart: style.paddingInlineStart, justifyContent: style.justifyContent,
        })
        shell.append(label)
    }
    dialog.append(shell)
    return { shell, image, label }
}

function opacity(element) {
    return element ? Number(getComputedStyle(element).opacity) : undefined
}

function snapshot(dialog) {
    const shell = dialog.querySelector('.lightbox-motion-flight')
    const panel = dialog.querySelector('[data-lightbox-panel]')
    const copy = panel?.querySelector('[data-lightbox-copy]')
    const label = shell?.querySelector(':scope > span')
    const labelCss = label && getComputedStyle(label)
    return {
        opacity: opacity(dialog),
        backdrop: getComputedStyle(dialog).backgroundColor,
        controls: new Map([...dialog.querySelectorAll(`${controls}, ${panelEdges}, .linen-lightbox-close`)].map(element => [element, opacity(element)])),
        qr: opacity(panel?.querySelector(qrSelector)),
        panel: opacity(panel),
        clip: panel && getComputedStyle(panel).clipPath,
        copy: copy && getComputedStyle(copy).transform,
        flight: shell && shape(shell.getBoundingClientRect(), getComputedStyle(shell), getComputedStyle(shell).backgroundColor),
        image: opacity(shell?.querySelector('img')),
        label: labelCss && { left: labelCss.left, top: labelCss.top, opacity: labelCss.opacity, ...labelStyle(labelCss) },
    }
}

function runMotion(dialog, { kind, origin, reverse, current, reduced }) {
    const animations = []
    let shell
    let hiddenOrigin
    const target = getTarget(dialog, kind)
    const rect = lightboxRect(target)
    const panel = kind === 'panel' || kind === 'museum'
    const museum = kind === 'museum'
    const button = origin?.kind === 'button' || origin?.kind === 'panel'
    const targetImage = target?.querySelector('.linen-lightbox-photo')
    const src = kind === 'video' ? (origin?.image || target?.poster)
        : panel ? origin?.image : (targetImage?.currentSrc || targetImage?.src)
    const travel = !reduced && origin?.rect && rect && (src || panel) && !target.classList.contains('is-zoomed')
        && !targetImage?.classList.contains('linen-lightbox-original')
    const duration = travel ? (panel && !museum ? (reverse ? 245 : 340) : (reverse ? 320 : 440)) : (reduced ? 110 : 160)
    const staged = travel && !panel ? [...dialog.querySelectorAll(controls)] : []
    const controlsFade = staged.some(element => !reverse || (current?.controls.get(element) ?? 1) > 0) ? (reverse ? 100 : 130) : 0
    const qr = travel ? target.querySelector(qrSelector) : null
    const qrOpacity = current?.qr ?? 1
    const qrFade = qr && (!reverse || qrOpacity > 0) ? (reverse ? 85 : 110) : 0
    const timing = { duration, delay: reverse ? Math.max(controlsFade, qrFade) : 0, fill: 'both',
        easing: reverse && panel && !museum ? reversePanelEase : ease }
    function play(element, frames, options) {
        if (element) animations.push(element.animate(frames, { ...timing, ...options }))
    }

    if (!travel) {
        const initial = current?.opacity ?? 1
        const backgroundColor = current?.backdrop ?? getComputedStyle(dialog).backgroundColor
        play(dialog, reverse ? [{ opacity: initial, backgroundColor }, { opacity: 0, backgroundColor }] : [{ opacity: 0 }, { opacity: 1 }])
    } else {
        const from = origin.rect
        const targetStyle = getComputedStyle(target)
        const sourceStyle = origin.visual?.isConnected ? getComputedStyle(origin.visual) : null
        const background = origin.background === clear && origin.element
            ? (sourceStyle?.getPropertyValue('--color-cream-dark').trim() || '#292620') : origin.background
        const edge = panel && sourceStyle ? insetBorder(sourceStyle) : `0 0 0 1px ${origin.border || clear}`
        const fromShape = shape(from, { borderRadius: origin.radius || '0px' }, background || clear, edge)
        const toShape = shape(rect, targetStyle, panel ? targetStyle.backgroundColor : (background || clear),
            panel ? insetBorder(targetStyle) : targetStyle.boxShadow)
        const flight = makeFlight(dialog, origin, src, panel)
        shell = flight.shell

        const sourceLabel = origin.element?.querySelector(labelSelector)
        const targetLabel = target.querySelector(labelSelector)
        const sharedLabel = flight.label && sourceLabel && targetLabel && sourceLabel.textContent === targetLabel.textContent
        if (sharedLabel) {
            flight.label.className = 'lightbox-motion-shared-label'
            flight.label.textContent = sourceLabel.textContent
            const fromLabel = labelPose(sourceLabel, from)
            const toLabel = labelPose(targetLabel, rect)
            Object.assign(flight.label.style, { font: getComputedStyle(sourceLabel).font, paddingInlineStart: '0' })
            play(flight.label, reverse ? [current?.label ?? toLabel, fromLabel] : [fromLabel, toLabel])
            dialog.dataset.lightboxSharedLabel = ''
        } else {
            play(flight.label, reverse ? [{ opacity: current?.label?.opacity ?? 0 }, { opacity: 0, offset: .46 }, { opacity: 1 }]
                : [{ opacity: 1 }, { opacity: 0, offset: .42 }, { opacity: 0 }])
        }
        // A utility button stays hidden under its own panel through the end of the close.
        if (origin.element?.isConnected && (sharedLabel || kind === 'panel')) {
            origin.element.dataset.lightboxMotionSource = ''
        } else if (origin.visual?.isConnected) {
            hiddenOrigin = origin.visual
            hiddenOrigin.dataset.lightboxMotionSource = ''
        }

        const backdrop = getComputedStyle(dialog).backgroundColor
        dialog.dataset.lightboxTravelling = kind
        play(shell, reverse ? [current?.flight ?? toShape, fromShape] : [fromShape, toShape])
        play(dialog, reverse ? [{ backgroundColor: current?.backdrop ?? backdrop }, { backgroundColor: clear }]
            : [{ backgroundColor: current?.backdrop ?? clear }, { backgroundColor: backdrop }])

        if (museum) {
            play(flight.image, reverse ? [{ opacity: current?.image ?? 0 }, { opacity: 0, offset: .45 }, { opacity: 1 }]
                : [{ opacity: 1 }, { opacity: 0, offset: .57 }, { opacity: 0 }], { easing: 'ease-out' })
        } else if (button) {
            play(flight.image, reverse ? [{ opacity: current?.image ?? 1 }, { opacity: 0, offset: .87 }, { opacity: 0 }]
                : [{ opacity: 0 }, { opacity: 0, offset: .14 }, { opacity: 1, offset: .82 }, { opacity: 1 }])
        }

        if (panel) {
            const originClip = clipTo(rect, from)
            const fittedClip = 'inset(0px)'
            const startClip = current?.clip && current.clip !== 'none' ? current.clip : fittedClip
            play(target, reverse ? [{ clipPath: startClip }, { clipPath: originClip }] : [{ clipPath: originClip }, { clipPath: fittedClip }])
            const copy = target.querySelector('[data-lightbox-copy]')
            if (copy) {
                const x = from.left - rect.left + (qr ? (from.width - rect.width) / 2 : 0)
                const y = from.top - rect.top + (qr ? (from.height - rect.height) / 2 : 0)
                const offset = `translate(${x}px, ${y}px)`
                play(copy, reverse ? [{ transform: current?.copy ?? 'none' }, { transform: offset }] : [{ transform: offset }, { transform: 'none' }])
            }
            play(target, reverse ? [{ opacity: current?.panel ?? 1 }, { opacity: 0, offset: museum ? .48 : .36 }, { opacity: 0 }]
                : [{ opacity: 0 }, { opacity: 0, offset: museum ? .15 : .31 }, { opacity: 1, offset: .91 }, { opacity: 1 }], { easing: 'linear' })
            play(qr, reverse ? [{ opacity: qrOpacity }, { opacity: 0 }] : [{ opacity: 0 }, { opacity: 1 }],
                { duration: qrFade, delay: reverse ? 0 : duration, easing: 'ease-out' })
        } else if (kind === 'photo') {
            // The lazy explorer viewer checks for running frame animations before taking over.
            target.classList.add('lightbox-motion-in-flight')
            play(target, [{ visibility: 'hidden' }, { visibility: 'hidden' }], { duration: duration + controlsFade, delay: 0 })
        }

        for (const element of staged) {
            play(element, reverse ? [{ opacity: current?.controls.get(element) ?? 1 }, { opacity: 0 }] : [{ opacity: 0 }, { opacity: 1 }],
                { duration: controlsFade, delay: reverse ? 0 : duration, easing: 'ease-out' })
        }
        for (const element of dialog.querySelectorAll(`${panelEdges}, .linen-lightbox-close`)) {
            const start = current?.controls.get(element) ?? (reverse ? 1 : 0)
            const edge = element.matches(panelEdges)
            play(element, reverse ? [{ opacity: start }, { opacity: 0, offset: edge ? .25 : .5 }, { opacity: 0 }]
                : [{ opacity: start }, { opacity: start, offset: edge ? .64 : .34 }, { opacity: 1 }], { easing: edge ? 'linear' : ease })
        }
    }
    return {
        done: Promise.allSettled(animations.map(animation => animation.finished)),
        cancel() {
            for (const animation of animations) animation.cancel()
            hiddenOrigin?.removeAttribute('data-lightbox-motion-source')
            shell?.remove()
            target?.classList.remove('lightbox-motion-in-flight')
            delete dialog.dataset.lightboxTravelling
            delete dialog.dataset.lightboxSharedLabel
        },
    }
}

export function installLightboxMotion(dialog, config, trigger) {
    if (!config || !dialog?.animate) return undefined
    const initial = config()
    if (!initial) return undefined
    const { kind } = initial
    const reduced = prefersReducedLightboxMotion()
    const origin = takeLightboxTrigger(initial.originKind ?? kind, initial.key, initial.origin, trigger)
    let run
    let frame
    let timer
    let observer
    let closing = false
    let onOpened = initial.onOpened

    const stopWaiting = () => {
        cancelAnimationFrame(frame)
        clearTimeout(timer)
        observer?.disconnect()
        delete dialog.dataset.lightboxAwaiting
    }
    const settle = () => {
        stopWaiting()
        run?.cancel()
        run = undefined
    }
    const finishEntrance = () => {
        settle()
        onOpened?.()
        onOpened = undefined
    }
    const start = (anchor, current) => {
        settle()
        const next = runMotion(dialog, { kind, origin: anchor, current, reduced })
        run = next
        next.done.then(() => { if (run === next && !closing) finishEntrance() })
    }
    const requestClose = (close) => {
        if (closing) return
        closing = true
        dialog.querySelector('video')?.pause()
        const current = snapshot(dialog)
        settle()
        const anchor = findLightboxReturn(origin, config()?.key)
        const exit = runMotion(dialog, { kind, origin: anchor, current, reverse: true, reduced })
        run = exit
        exit.done.then(() => { if (run === exit) close() })
    }
    lightboxMotionControllers.set(dialog, { requestClose, settle: () => { if (!closing) finishEntrance() } })

    if (!reduced && origin && (kind === 'photo' || kind === 'video')) {
        dialog.dataset.lightboxAwaiting = ''
        const schedule = () => {
            cancelAnimationFrame(frame)
            frame = requestAnimationFrame(() => {
                if (!getTarget(dialog, kind)) return
                start(origin, snapshot(dialog))
            })
        }
        observer = new MutationObserver(schedule)
        observer.observe(dialog, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] })
        timer = window.setTimeout(() => start(null), 1250)
        schedule()
    } else start(origin)

    return () => {
        // Route changes and nested layer teardown cancel visual work and restore the trigger.
        closing = true
        settle()
        origin?.element?.removeAttribute('data-lightbox-motion-source')
        lightboxMotionControllers.delete(dialog)
    }
}
