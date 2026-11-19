import { findLightboxReturn, lightboxRect, prefersReducedLightboxMotion, takeLightboxTrigger } from './lightboxOrigin'
import { lightboxMotionControllers } from './lightboxMotionControl'

const photoFrame = '.linen-lightbox-photo-frame.is-loaded:not(.is-hidden, .is-outgoing)'
const controlsOpacity = '--lightbox-controls-opacity'
const panelEdges = '.museum-album-toolbar, .museum-album-footer, .section-stats-close'
const labelSelector = '[data-lightbox-label]'
const qrSelector = '[data-lightbox-qr]'
const ease = 'cubic-bezier(.22,.68,.25,1)'
const reversePanelEase = 'cubic-bezier(.45,0,.28,1)'
const clear = 'rgba(0, 0, 0, 0)'
const photoLandingMs = 240
const photoReturnMs = 340
const photoButtonCloseMs = 430
const photoButtonCloseEase = 'cubic-bezier(.33,0,.32,1)'

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

function videoRatio(video) {
    const ratio = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight
        : Number(video.dataset.videoWidth) / Number(video.dataset.videoHeight)
    return Number.isFinite(ratio) && ratio > 0 ? ratio : null
}

function containedVideoRect(box, ratio) {
    const width = Math.min(box.width, box.height * ratio)
    const height = Math.min(box.height, box.width / ratio)
    return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height }
}

function waitForVideoFrame(video, signal) {
    if (signal.aborted || video.readyState >= video.HAVE_CURRENT_DATA) return
    return new Promise(resolve => {
        const finish = () => {
            video.removeEventListener('loadeddata', finish)
            video.removeEventListener('playing', finish)
            signal.removeEventListener('abort', finish)
            resolve()
        }
        video.addEventListener('loadeddata', finish)
        video.addEventListener('playing', finish)
        signal.addEventListener('abort', finish, { once: true })
    })
}

function stageVideoHandoff(video, flight, travel, play) {
    const controller = new AbortController()
    const done = travel.finished.then(async () => {
        await waitForVideoFrame(video, controller.signal)
        if (controller.signal.aborted) return
        const timing = { delay: 0, duration: 235, easing: 'ease-in-out' }
        // Keep the video fully painted behind the still. Soften the old edges before the blend.
        play(video, [{ opacity: 1 }, { opacity: 1 }], timing)
        play(flight.image, [{ filter: 'blur(0px)' }, { filter: 'blur(6px)', offset: .52 }, { filter: 'blur(6px)' }],
            { ...timing, easing: 'linear' })
        const still = play(flight.shell, [{ opacity: 1 }, { opacity: 1, offset: .15 }, { opacity: 0 }], timing)
        await still.finished.catch(() => {})
    }, () => {})
    return { done, cancel: () => controller.abort() }
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
    const label = origin.kind === 'panel' && origin.element ? document.createElement('span') : null
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

function playPhotoTravel(flight, from, to, fromShape, toShape, play, reverse, duration) {
    const { shell, image } = flight
    const { boxShadow, borderRadius, backgroundColor, ...surface } = toShape
    Object.assign(shell.style, surface)
    shell.classList.add('lightbox-motion-photo-flight')

    const crop = document.createElement('div')
    crop.className = 'lightbox-motion-crop'
    crop.style.backgroundColor = backgroundColor
    crop.append(image)
    const rim = document.createElement('div')
    rim.className = 'lightbox-motion-rim'
    Object.assign(rim.style, { borderRadius, boxShadow })
    shell.append(crop, rim)

    const startX = from.width / to.width
    const startY = from.height / to.height
    const thumbnail = { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${startX}, ${startY})` }
    const fitted = { transform: 'translate(0px, 0px) scale(1, 1)' }
    const options = { duration }
    play(shell, reverse ? [fitted, thumbnail] : [thumbnail, fitted], options)
    if (startX !== startY) {
        // The shell changes aspect ratio to reveal the crop. Counter-scale
        // the image around its center so the photograph itself never stretches.
        play(image, Array.from({ length: 17 }, (_, step) => {
            const offset = step / 16
            const progress = reverse ? 1 - offset : offset
            const x = startX + (1 - startX) * progress
            const y = startY + (1 - startY) * progress
            const cover = Math.max(x, y)
            return { offset, transform: `scale(${cover / x}, ${cover / y})` }
        }), options)
    }
    const thumbnailCorner = { borderRadius: fromShape.borderRadius }
    const fittingCorner = { borderRadius }
    if (fromShape.borderRadius !== borderRadius) play(crop, reverse ? [fittingCorner, thumbnailCorner] : [thumbnailCorner, fittingCorner], options)
    else crop.style.borderRadius = borderRadius
    // The thumbnail frame stays behind the dialog. Fade the viewer rim as
    // the photo moves so its shadow can reuse one painted layer.
    play(rim, reverse ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 0 }, { opacity: 1 }], options)
}

function opacity(element) {
    return element ? Number(getComputedStyle(element).opacity) : undefined
}

function snapshot(dialog) {
    const shell = dialog.querySelector('.lightbox-motion-flight')
    const panel = dialog.querySelector('[data-lightbox-panel]')
    const copy = panel?.querySelector('[data-lightbox-copy]')
    const label = shell?.querySelector(':scope > span')
    const rim = shell?.querySelector('.lightbox-motion-rim')
    const crop = shell?.querySelector('.lightbox-motion-crop')
    const flightStyle = shell && getComputedStyle(crop ?? shell)
    const labelCss = label && getComputedStyle(label)
    const dialogStyle = getComputedStyle(dialog)
    return {
        opacity: Number(dialogStyle.opacity),
        backdrop: dialogStyle.backgroundColor,
        controlsOpacity: Number(dialogStyle.getPropertyValue(controlsOpacity) || 1),
        controls: new Map([...dialog.querySelectorAll(`${panelEdges}, .linen-lightbox-close`)].map(element => [element, opacity(element)])),
        panel: opacity(panel),
        clip: panel && getComputedStyle(panel).clipPath,
        copy: copy && getComputedStyle(copy).transform,
        flight: shell && shape(shell.getBoundingClientRect(), flightStyle, flightStyle.backgroundColor,
            rim && opacity(rim) < .5 ? 'none' : getComputedStyle(rim ?? shell).boxShadow),
        image: opacity(shell?.querySelector('img')),
        flightOpacity: opacity(shell),
        label: labelCss && { left: labelCss.left, top: labelCss.top, opacity: labelCss.opacity, ...labelStyle(labelCss) },
    }
}

function snapshotQr(dialog) {
    const panel = dialog.querySelector('[data-lightbox-panel]')
    return { backdrop: getComputedStyle(dialog).backgroundColor, panel: opacity(panel),
        transform: getComputedStyle(panel).transform, image: opacity(panel.querySelector(qrSelector)),
        close: opacity(dialog.querySelector('.linen-lightbox-close')) }
}

function runQrMotion(dialog, { origin, current, reverse, reduced }) {
    const panel = dialog.querySelector('[data-lightbox-panel]')
    const close = dialog.querySelector('.linen-lightbox-close')
    const qr = panel.querySelector(qrSelector)
    const bounds = panel.getBoundingClientRect()
    const from = origin?.rect
    const toward = difference => Math.max(-64, Math.min(64, difference * .3))
    const x = from ? toward(from.left + from.width / 2 - bounds.left - bounds.width / 2) : 0
    const y = from ? toward(from.top + from.height / 2 - bounds.top - bounds.height / 2) : 0
    const small = reduced ? 'none' : `translate(${x}px, ${y}px) scale(${from ? .82 : .96})`
    const backdrop = getComputedStyle(dialog).backgroundColor
    const timing = { duration: reduced ? 110 : reverse ? 310 : 330, easing: reverse ? 'ease-in-out' : ease, fill: 'both' }
    const animations = [
        dialog.animate(reverse ? [{ backgroundColor: current.backdrop }, { backgroundColor: clear }]
            : [{ backgroundColor: clear }, { backgroundColor: backdrop }], timing),
        panel.animate(reverse ? [{ opacity: current.panel, transform: current.transform }, { opacity: 0, transform: small }]
            : [{ opacity: 0, transform: small }, { opacity: 1, transform: 'none' }], timing),
    ]
    if (close) animations.push(close.animate(reverse ? [{ opacity: current.close }, { opacity: 0 }]
        : [{ opacity: 0 }, { opacity: 1 }], timing))

    if (reverse) {
        dialog.dataset.qrClosing = ''
        if (qr) animations.push(qr.animate([{ opacity: current.image ?? 0 }, { opacity: 0 }], {
            ...timing, duration: reduced ? 110 : 195,
        }))
    } else dialog.dataset.qrOpening = ''

    return {
        done: Promise.allSettled(animations.map(animation => animation.finished)),
        cancel() {
            for (const animation of animations) animation.cancel()
            delete dialog.dataset.qrOpening
            delete dialog.dataset.qrClosing
        },
    }
}

function runMotion(dialog, { kind, origin, originKind = origin?.kind, reverse, current, reduced }) {
    const animations = []
    let shell
    let hiddenOrigin
    let videoHandoff
    const target = getTarget(dialog, kind)
    const box = lightboxRect(target)
    const video = kind === 'video'
    const videoEntrance = video && !reverse
    const ratio = video && target && videoRatio(target)
    const rect = video ? box && ratio && containedVideoRect(box, ratio) : box
    const panel = kind === 'panel' || kind === 'museum'
    const museum = kind === 'museum'
    const photoButton = kind === 'photo' && originKind === 'button'
    const photoButtonClose = reverse && photoButton && !reduced
    const photoReturn = reverse && kind === 'photo' && origin?.kind === 'photo'
    const targetImage = target?.querySelector('.linen-lightbox-photo')
    const src = video ? (origin?.image || target?.poster)
        : panel ? origin?.image : (targetImage?.currentSrc || targetImage?.src)
    const travel = !reduced && origin?.rect && rect && (src || panel) && !target.classList.contains('is-zoomed')
        && !targetImage?.classList.contains('linen-lightbox-original')
        && !(reverse && kind === 'photo' && dialog.querySelector('.linen-lightbox-photo-frame.is-outgoing'))
    const photoDissolve = reverse && kind === 'photo' && !travel && !reduced
    const duration = !travel ? (reduced ? 110 : videoEntrance ? 280 : 160)
        : photoButtonClose ? photoButtonCloseMs : photoReturn ? photoReturnMs
            : panel && !museum ? (reverse ? 245 : 340) : (reverse ? 320 : 440)
    const staged = travel && !panel
    const visibleControls = current?.controlsOpacity ?? 1
    const controlsFade = staged && (!reverse || visibleControls > 0)
        ? (photoButtonClose ? 160 : reverse ? 100 : videoEntrance ? 260 : 130) : 0
    const controlsTiming = { duration: controlsFade, delay: reverse ? 0 : duration + (videoEntrance ? 60 : 0),
        easing: videoEntrance ? 'ease-in-out' : 'ease-out' }
    const timing = { duration, delay: reverse && !photoButtonClose ? controlsFade : 0, fill: 'both',
        easing: photoButtonClose ? photoButtonCloseEase : reverse && panel && !museum ? reversePanelEase : ease }
    function play(element, frames, options) {
        if (!element) return
        const animation = element.animate(frames, { ...timing, ...options })
        animations.push(animation)
        return animation
    }

    if (photoDissolve) {
        dialog.dataset.lightboxDissolving = ''
        const backgroundColor = current?.backdrop ?? getComputedStyle(dialog).backgroundColor
        const fadeOut = photoButtonClose ? { duration: photoButtonCloseMs, easing: photoButtonCloseEase }
            : { duration: 360, easing: 'cubic-bezier(.42,0,.35,1)' }
        const chromeFade = { duration: 160, easing: 'ease-out' }
        play(dialog, [{ opacity: current?.opacity ?? 1, backgroundColor }, { opacity: 0, backgroundColor }], fadeOut)
        play(dialog, [{ [controlsOpacity]: visibleControls }, { [controlsOpacity]: 0 }], chromeFade)
        const closeButton = dialog.querySelector('.linen-lightbox-close')
        play(closeButton, [{ opacity: current?.controls.get(closeButton) ?? 1 }, { opacity: 0 }], chromeFade)
    } else if (!travel) {
        const initial = current?.opacity ?? 1
        const backgroundColor = current?.backdrop ?? getComputedStyle(dialog).backgroundColor
        play(dialog, reverse ? [{ opacity: initial, backgroundColor }, { opacity: 0, backgroundColor }] : [{ opacity: 0 }, { opacity: 1 }])
    } else {
        const thumbnail = photoReturn ? origin.visual?.querySelector('img') : null
        const thumbnailRect = lightboxRect(thumbnail, { allowPartial: true })
        const thumbnailStyle = thumbnailRect ? getComputedStyle(thumbnail) : null
        const from = thumbnailRect ?? origin.rect
        const targetStyle = getComputedStyle(target)
        const sourceStyle = origin.visual?.isConnected ? getComputedStyle(origin.visual) : null
        const sourceBackground = origin.background === clear && origin.element
            ? (sourceStyle?.getPropertyValue('--color-cream-dark').trim() || '#292620') : origin.background
        const background = photoButton ? clear : sourceBackground
        const edge = photoButton || photoReturn ? 'none' : panel && sourceStyle ? insetBorder(sourceStyle) : `0 0 0 1px ${origin.border || clear}`
        const fromShape = shape(from, { borderRadius: thumbnailStyle?.borderRadius || origin.radius || '0px' }, background || clear, edge)
        const toShape = shape(rect, targetStyle, panel ? targetStyle.backgroundColor : (background || clear),
            panel ? insetBorder(targetStyle) : targetStyle.boxShadow)
        const flight = makeFlight(dialog, origin, src, panel)
        shell = flight.shell
        const player = videoEntrance ? target.parentElement : null
        const playerBackground = player && getComputedStyle(player).backgroundColor
        const playerFrame = player?.closest('.linen-lightbox-content')
        const frameShadow = playerFrame && getComputedStyle(playerFrame).boxShadow

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
        } else if (kind !== 'photo' && origin.visual?.isConnected) {
            hiddenOrigin = origin.visual
            hiddenOrigin.dataset.lightboxMotionSource = ''
        }

        const backdrop = getComputedStyle(dialog).backgroundColor
        dialog.dataset.lightboxTravelling = kind
        let flightTravel
        const touchPhoto = kind === 'photo' && window.matchMedia?.('(pointer: coarse)').matches
        const thumbnailEntrance = kind === 'photo' && !reverse && origin.kind === 'photo'
        // A settled viewer starts at its fitted size. Interrupted entrances keep
        // the positional fallback so an in-flight pose can still reverse in place.
        if (thumbnailEntrance || (touchPhoto && !current?.flight)) {
            playPhotoTravel(flight, from, rect, fromShape, toShape, play, reverse, photoReturn ? photoLandingMs : duration)
        } else {
            flightTravel = play(shell, reverse ? [current?.flight ?? toShape, fromShape] : [fromShape, toShape],
                photoReturn ? { duration: photoLandingMs } : undefined)
        }
        play(dialog, reverse ? [{ backgroundColor: current?.backdrop ?? backdrop }, { backgroundColor: clear }]
            : [{ backgroundColor: current?.backdrop ?? clear }, { backgroundColor: backdrop }])

        if (videoEntrance) {
            const landing = { delay: duration, duration: 180, fill: 'forwards', easing: 'ease-out' }
            play(player, [{ backgroundColor: clear }, { backgroundColor: playerBackground }], landing)
            play(playerFrame, [{ boxShadow: 'none' }, { boxShadow: frameShadow }], landing)
            videoHandoff = stageVideoHandoff(target, flight, flightTravel, play)
        }

        if (museum) {
            play(flight.image, reverse ? [{ opacity: current?.image ?? 0 }, { opacity: 0, offset: .45 }, { opacity: 1 }]
                : [{ opacity: 1 }, { opacity: 0, offset: .57 }, { opacity: 0 }], { easing: 'ease-out' })
        } else if (photoButton) {
            // The real button stays in place. Fade the picture and its frame together.
            const start = current?.flightOpacity ?? 1
            play(shell, reverse ? [{ opacity: start }, { opacity: start, offset: .12 }, { opacity: 0, offset: .92 }, { opacity: 0 }]
                : [{ opacity: 0 }, { opacity: 0, offset: .12 }, { opacity: 1, offset: .82 }, { opacity: 1 }])
        } else if (photoReturn) {
            play(shell, [{ opacity: 1 }, { opacity: 1, offset: .45 }, { opacity: 0 }], { easing: 'linear' })
            if (thumbnailStyle && flight.image) {
                const objectPosition = getComputedStyle(targetImage).objectPosition
                if (objectPosition !== thumbnailStyle.objectPosition) {
                    play(flight.image, [{ objectPosition }, { objectPosition: thumbnailStyle.objectPosition }], { duration: photoLandingMs })
                }
            }
        }

        if (panel) {
            const originClip = clipTo(rect, from)
            const fittedClip = 'inset(0px)'
            const startClip = current?.clip && current.clip !== 'none' ? current.clip : fittedClip
            play(target, reverse ? [{ clipPath: startClip }, { clipPath: originClip }] : [{ clipPath: originClip }, { clipPath: fittedClip }])
            const copy = target.querySelector('[data-lightbox-copy]')
            if (copy) {
                const x = from.left - rect.left
                const y = from.top - rect.top
                const offset = `translate(${x}px, ${y}px)`
                play(copy, reverse ? [{ transform: current?.copy ?? 'none' }, { transform: offset }] : [{ transform: offset }, { transform: 'none' }])
            }
            play(target, reverse ? [{ opacity: current?.panel ?? 1 }, { opacity: 0, offset: museum ? .48 : .36 }, { opacity: 0 }]
                : [{ opacity: 0 }, { opacity: 0, offset: museum ? .15 : .31 }, { opacity: 1, offset: .91 }, { opacity: 1 }], { easing: 'linear' })
        } else if (kind === 'photo') {
            // The lazy explorer viewer checks for running frame animations before taking over.
            target.classList.add('lightbox-motion-in-flight')
            play(target, [{ visibility: 'hidden' }, { visibility: 'hidden' }], { duration: duration + (reverse ? timing.delay : controlsFade), delay: 0 })
        }

        if (staged) {
            play(dialog, reverse ? [{ [controlsOpacity]: visibleControls }, { [controlsOpacity]: 0 }] : [{ [controlsOpacity]: 0 }, { [controlsOpacity]: 1 }],
                controlsTiming)
        }
        for (const element of dialog.querySelectorAll(`${panelEdges}, .linen-lightbox-close`)) {
            const start = current?.controls.get(element) ?? (reverse ? 1 : 0)
            const edge = element.matches(panelEdges)
            if (videoEntrance && !edge) {
                play(element, [{ opacity: 0 }, { opacity: 1 }], controlsTiming)
                continue
            }
            play(element, reverse ? [{ opacity: start }, { opacity: 0, offset: edge ? .25 : .5 }, { opacity: 0 }]
                : [{ opacity: start }, { opacity: start, offset: edge ? .64 : .34 }, { opacity: 1 }], { easing: edge ? 'linear' : ease })
        }
    }
    return {
        done: Promise.allSettled([...animations.map(animation => animation.finished), videoHandoff?.done]),
        cancel() {
            videoHandoff?.cancel()
            for (const animation of animations) animation.cancel()
            hiddenOrigin?.removeAttribute('data-lightbox-motion-source')
            shell?.remove()
            target?.classList.remove('lightbox-motion-in-flight')
            delete dialog.dataset.lightboxTravelling
            delete dialog.dataset.lightboxSharedLabel
            delete dialog.dataset.lightboxDissolving
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
    const animate = kind === 'qr' ? runQrMotion : runMotion
    const readPose = kind === 'qr' ? snapshotQr : snapshot
    let run
    let frame
    let timer
    let observer
    let waitingForMetadata
    let closing = false
    let onOpened = initial.onOpened

    const stopWaiting = () => {
        cancelAnimationFrame(frame)
        clearTimeout(timer)
        observer?.disconnect()
        if (waitingForMetadata) dialog.removeEventListener('loadedmetadata', waitingForMetadata, true)
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
        const next = animate(dialog, { kind, origin: anchor, current, reduced })
        run = next
        next.done.then(() => { if (run === next && !closing) finishEntrance() })
    }
    const requestClose = (close) => {
        if (closing) return
        closing = true
        dialog.querySelector('video')?.pause()
        const current = readPose(dialog)
        settle()
        const anchor = findLightboxReturn(origin, config()?.key)
        const exit = animate(dialog, { kind, origin: anchor, originKind: initial.originKind ?? origin?.kind, current, reverse: true, reduced })
        run = exit
        exit.done.then(() => { if (run === exit) close() })
    }
    lightboxMotionControllers.set(dialog, { requestClose, settle: () => { if (!closing) finishEntrance() } })

    if (!reduced && origin?.rect && (kind === 'photo' || kind === 'video')) {
        dialog.dataset.lightboxAwaiting = ''
        const schedule = () => {
            cancelAnimationFrame(frame)
            frame = requestAnimationFrame(() => {
                const target = getTarget(dialog, kind)
                if (!target || (kind === 'video' && !videoRatio(target))) return
                start(origin, snapshot(dialog))
            })
        }
        observer = new MutationObserver(schedule)
        observer.observe(dialog, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] })
        if (kind === 'video') {
            waitingForMetadata = schedule
            dialog.addEventListener('loadedmetadata', waitingForMetadata, true)
        }
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
