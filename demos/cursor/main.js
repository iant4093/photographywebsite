import landscape from './assets/landscape.webp'
import portrait from './assets/portrait.webp'

// Functional cursor symbols. The camera lens stays on the (12, 12) hotspot
// when the flash appears, so hovering never shifts the point of interaction.
const paths = {
  camera: '<path d="M8 5 9.5 3.5h5L16 5h4a1.5 1.5 0 0 1 1.5 1.5V18a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 18V6.5A1.5 1.5 0 0 1 4 5Z"/><circle cx="12" cy="12" r="4.2"/><path d="M18 8h.5"/><circle cx="12" cy="12" r=".55"/>',
  arrow: '<path d="m5 19 14-14M5 5h14v14"/>',
  zoom: '<circle cx="10" cy="10" r="6.5"/><path d="m15 15 6 6M7 10h6m-3-3v6"/>',
  'zoom-out': '<circle cx="10" cy="10" r="6.5"/><path d="m15 15 6 6M7 10h6"/>',
  drag: '<path d="M2 12h20M6 8l-4 4 4 4m12-8 4 4-4 4M10 8v8m4-8v8"/>',
  dragging: '<path d="M5 12h14M8 9l-3 3 3 3m8-6 3 3-3 3M10.5 10v4m3-4v4"/>',
  next: '<path d="M3 12h18m-7-7 7 7-7 7"/>',
  previous: '<path d="M21 12H3m7-7-7 7 7 7"/>',
  close: '<path d="m5 5 14 14M19 5 5 19"/>',
  text: '<path d="M8 3h8M12 3v18m-4 0h8"/>',
  loading: '<circle cx="12" cy="12" r="9"/><path d="m12 3 5 9m3-6-6 9m4 4H8m4 2-5-9m-3 6 6-9M6 5h10"/>',
  disabled: '<circle cx="12" cy="12" r="8"/><path d="m6.3 6.3 11.4 11.4"/>',
  system: '<path d="m5 3 1 18 5-6 7 1Z"/>',
}

function icon(name, contrast = false) {
  const flash = '<g class="flash-rays"><path d="M18 1v-3m3 5 2.5-2.5M23 7h3"/></g>'
  const geometry = name === 'view' ? paths.camera + flash : paths[name] || paths.camera
  const outline = contrast ? `<g stroke="#fffdf8" stroke-width="4.2">${geometry}</g>` : ''
  return `<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${outline}<g stroke="${contrast ? '#231f1a' : 'currentColor'}" stroke-width="1.55">${geometry}</g></svg>`
}

const descriptions = {
  camera: ['Camera / resting', 'A small camera, with the lens at your exact click position.'],
  view: ['Photograph / camera flash', 'A small flash pops from the camera as you enter a photograph, then settles into quiet rays.'],
  arrow: ['Link / go', 'A simple arrow makes navigation feel immediately clickable.'],
  zoom: ['Photograph / zoom in', 'A familiar magnifier when there is more detail to see.'],
  'zoom-out': ['Photograph / zoom out', 'The minus sign returns the photograph to its full frame.'],
  drag: ['Contact sheet / drag', 'Horizontal arrows show that this strip can be moved sideways.'],
  dragging: ['Contact sheet / held', 'The arrows pull inward while you hold and move the strip.'],
  next: ['Photograph / next', 'A right arrow points to the next photograph.'],
  previous: ['Photograph / previous', 'A left arrow points to the previous photograph.'],
  close: ['Viewer / close', 'A simple cross closes the photograph. Escape works too.'],
  text: ['Text / native cursor', 'The usual I-beam keeps writing and selecting text familiar.'],
  native: ['Control / native cursor', 'Sliders and menus keep their familiar system pointer.'],
  disabled: ['Unavailable / native cursor', 'The standard unavailable cursor says this action cannot be used.'],
  loading: ['Loading / aperture', 'A gently rotating aperture. This is a short loading simulation.'],
  system: ['System / original cursor', 'Use your normal pointer to compare how the custom cursor feels.'],
}
const actionLabels = { view: 'View', arrow: 'Go', zoom: 'Zoom in', 'zoom-out': 'Zoom out', drag: 'Drag', dragging: 'Dragging', next: 'Next', previous: 'Previous', close: 'Close', loading: 'Loading' }
const defaults = { mode: 'camera', size: 20, labels: false, feedback: true, dark: false }
// Apply the chosen size and label defaults even in a tab that saved an earlier version.
const storageKey = 'ian-cursor-study-v3'
let settings = { ...defaults }
try {
  const saved = JSON.parse(localStorage.getItem(storageKey))
  if (saved && ['camera', 'system'].includes(saved.mode)) {
    settings = { mode: saved.mode, size: Math.min(36, Math.max(20, Number(saved.size) || defaults.size)), labels: saved.labels === true, feedback: saved.feedback !== false, dark: saved.dark === true }
  } else {
    const previous = JSON.parse(localStorage.getItem('ian-cursor-study-v2'))
    if (previous) {
      settings.dark = previous.dark === true
      settings.feedback = previous.feedback !== false
    }
  }
} catch { /* Storage is optional for this local study. */ }

const $ = (selector) => document.querySelector(selector)
const cursor = $('#custom-cursor')
const shape = cursor.querySelector('.cursor-shape')
const label = cursor.querySelector('.cursor-label')
const finePointer = window.matchMedia('(any-pointer: fine)')
const forcedColors = window.matchMedia('(forced-colors: active)')
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
let pointer = { x: -100, y: -100, inside: false, type: 'mouse' }
let lastTarget = document.body
let currentState = ''
let currentPhotoTarget = null
let frame = 0
let loading = false
let dragging = false
let pressTimer

document.querySelectorAll('[data-sample]').forEach((node) => { node.innerHTML = icon(node.dataset.sample) })

function hideCursor() {
  document.documentElement.classList.remove('custom-active')
  cursor.classList.remove('visible', 'pressed')
}

function stateFor(target) {
  if (target.closest(':disabled, [aria-disabled="true"]')) return 'disabled'
  if (target.closest('input:is([type="text"], [type="email"]), textarea, [contenteditable="true"], [data-native="text"]')) return 'text'
  if (target.closest('input[type="range"], select')) return 'native'
  if (settings.mode === 'system') return 'system'
  if (dragging) return 'dragging'
  if (loading) return 'loading'
  const explicit = target.closest('[data-cursor]')?.dataset.cursor
  if (explicit && descriptions[explicit]) return explicit
  if (target.closest('button, a, label, input[type="radio"], input[type="checkbox"]')) return 'arrow'
  return settings.mode
}

function updateCursor() {
  frame = 0
  const state = stateFor(lastTarget)
  const photoTarget = state === 'view' ? lastTarget.closest('[data-cursor="view"]') : null
  if (currentState !== state || currentPhotoTarget !== photoTarget) {
    currentState = state
    currentPhotoTarget = photoTarget
    cursor.dataset.state = state
    shape.innerHTML = icon(state, true)
    label.textContent = actionLabels[state] || ''
    $('#state-icon').innerHTML = icon(state === 'native' ? 'system' : state)
    $('#state-name').textContent = descriptions[state][0]
    $('#state-description').textContent = descriptions[state][1]
  }
  const allowed = finePointer.matches && !forcedColors.matches && settings.mode !== 'system' && pointer.type !== 'touch' && pointer.inside
  const native = ['text', 'native', 'disabled', 'system'].includes(state)
  document.documentElement.classList.toggle('custom-active', allowed && !native)
  cursor.classList.toggle('visible', allowed && !native)
  cursor.classList.toggle('show-label', settings.labels && Boolean(actionLabels[state]))
  cursor.classList.toggle('label-left', pointer.x > window.innerWidth - 110)
  cursor.style.transform = `translate3d(${pointer.x}px, ${pointer.y}px, 0)`
}

function scheduleUpdate() {
  if (!frame) frame = requestAnimationFrame(updateCursor)
}

function refreshTarget() {
  lastTarget = document.elementFromPoint(pointer.x, pointer.y) || document.body
  scheduleUpdate()
}

function applySettings() {
  document.documentElement.style.setProperty('--cursor-size', `${settings.size}px`)
  document.querySelectorAll('input[name="mode"]').forEach((input) => { input.checked = input.value === settings.mode })
  $('#cursor-size').value = settings.size
  $('#size-value').textContent = `${settings.size} px`
  $('#labels').checked = settings.labels
  $('#feedback').checked = settings.feedback
  $('.playground').classList.toggle('dark', settings.dark)
  $('#theme-toggle').setAttribute('aria-pressed', String(settings.dark))
  $('#theme-toggle').textContent = settings.dark ? 'Light background' : 'Dark background'
  try { localStorage.setItem(storageKey, JSON.stringify(settings)) } catch { /* Optional. */ }
  $('#device-note').textContent = forcedColors.matches
    ? 'Your high-contrast setting keeps the system cursor.'
    : !finePointer.matches
      ? 'Connect a mouse or trackpad to try the custom cursor. Touch keeps its usual behavior.'
      : reducedMotion.matches
        ? 'Reduced motion is on: cursor animations are disabled. Text fields keep the normal cursor.'
        : 'Text fields keep the normal cursor. Touch devices keep their usual behavior.'
  updateCursor()
}

document.addEventListener('pointermove', (event) => {
  pointer = { x: event.clientX, y: event.clientY, type: event.pointerType, inside: true }
  lastTarget = event.target instanceof Element ? event.target : document.body
  scheduleUpdate()
}, { passive: true })
document.addEventListener('pointerover', (event) => {
  if (event.target instanceof Element) lastTarget = event.target
  scheduleUpdate()
}, { passive: true })
document.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'touch') { pointer.type = 'touch'; hideCursor(); return }
  if (!settings.feedback || reducedMotion.matches) return
  clearTimeout(pressTimer)
  cursor.classList.add('pressed')
}, { passive: true })
document.addEventListener('pointerup', () => {
  pressTimer = setTimeout(() => cursor.classList.remove('pressed'), 100)
}, { passive: true })
function suspendPointer() { pointer.inside = false; hideCursor() }
document.documentElement.addEventListener('pointerleave', suspendPointer)
window.addEventListener('blur', suspendPointer)
document.addEventListener('visibilitychange', () => { if (document.hidden) suspendPointer() })
document.addEventListener('keydown', (event) => { if (event.key === 'Tab') suspendPointer() })
document.addEventListener('scroll', refreshTarget, { capture: true, passive: true })
window.addEventListener('resize', refreshTarget, { passive: true })
finePointer.addEventListener('change', applySettings)
forcedColors.addEventListener('change', applySettings)
reducedMotion.addEventListener('change', applySettings)

document.querySelectorAll('input[name="mode"]').forEach((input) => {
  input.addEventListener('change', () => { settings.mode = input.value; applySettings() })
})
$('#cursor-size').addEventListener('input', (event) => { settings.size = Number(event.target.value); applySettings() })
$('#labels').addEventListener('change', (event) => { settings.labels = event.target.checked; applySettings() })
$('#feedback').addEventListener('change', (event) => { settings.feedback = event.target.checked; applySettings() })
$('#theme-toggle').addEventListener('click', () => { settings.dark = !settings.dark; applySettings() })
$('#reset').addEventListener('click', () => { settings = { ...defaults }; applySettings(); $('#notice').textContent = 'Back to the starting camera.' })
$('#copy-settings').addEventListener('click', async () => {
  const summary = `Cursor study: ${settings.mode}, ${settings.size}px, camera flash on photo hover, action labels ${settings.labels ? 'on' : 'off'}, shutter feedback ${settings.feedback ? 'on' : 'off'}, ${settings.dark ? 'dark' : 'light'} background.`
  try { await navigator.clipboard.writeText(summary); $('#notice').textContent = 'Copied. Paste this into our conversation.' }
  catch { $('#notice').textContent = summary }
})
$('#loading-demo').addEventListener('click', () => {
  if (loading) return
  loading = true
  $('#loading-demo').setAttribute('aria-busy', 'true')
  $('#notice').textContent = 'Trying the loading cursor for two seconds…'
  updateCursor()
  setTimeout(() => {
    loading = false
    $('#loading-demo').removeAttribute('aria-busy')
    $('#notice').textContent = 'Ready. The loading preview is complete.'
    refreshTarget()
  }, 2000)
})

const strip = $('.filmstrip')
let dragStart = 0
let scrollStart = 0
strip.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'touch' || event.button !== 0) return
  event.preventDefault()
  strip.focus({ preventScroll: true })
  strip.setPointerCapture(event.pointerId)
  dragging = true
  dragStart = event.clientX
  scrollStart = strip.scrollLeft
  strip.classList.add('is-dragging')
  updateCursor()
})
strip.addEventListener('pointermove', (event) => { if (dragging) strip.scrollLeft = scrollStart - (event.clientX - dragStart) })
function endDrag() { dragging = false; strip.classList.remove('is-dragging'); cursor.classList.remove('pressed'); refreshTarget() }
strip.addEventListener('pointerup', endDrag)
strip.addEventListener('pointercancel', endDrag)
strip.addEventListener('lostpointercapture', endDrag)
window.addEventListener('blur', endDrag)
strip.addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  if (event.key === 'Home') strip.scrollLeft = 0
  else if (event.key === 'End') strip.scrollLeft = strip.scrollWidth
  else strip.scrollLeft += event.key === 'ArrowRight' ? 180 : -180
})

const photos = [
  { src: landscape, title: 'Out in the quiet.', alt: 'A hiker on a snowy mountain trail beside an evergreen tree' },
  { src: portrait, title: 'A familiar face.', alt: 'A portrait in warm afternoon light, with golden leaves in the background' },
]
const viewer = $('#viewer')
const imageArea = $('#viewer-image-area')
let photoIndex = 0
let zoomed = false
function setZoom(value) {
  zoomed = value
  imageArea.classList.toggle('zoomed', value)
  $('#zoom-photo').dataset.cursor = value ? 'zoom-out' : 'zoom'
  $('#zoom-photo').setAttribute('aria-label', value ? 'Zoom out of photograph' : 'Zoom in on photograph')
  $('#zoom-photo').setAttribute('aria-pressed', String(value))
  if (value) {
    imageArea.scrollLeft = (imageArea.scrollWidth - imageArea.clientWidth) / 2
    imageArea.scrollTop = (imageArea.scrollHeight - imageArea.clientHeight) / 2
  } else { imageArea.scrollLeft = 0; imageArea.scrollTop = 0 }
  refreshTarget()
}
function renderPhoto() {
  const photo = photos[photoIndex]
  $('#viewer-image').src = photo.src
  $('#viewer-image').alt = photo.alt
  $('#viewer-title').textContent = photo.title
  $('#viewer-count').textContent = `0${photoIndex + 1} / 02`
  setZoom(false)
}
function openPhoto(index) {
  photoIndex = index
  renderPhoto()
  viewer.append(cursor)
  viewer.showModal()
  $('#close-viewer').focus({ preventScroll: true })
  refreshTarget()
}
document.querySelectorAll('[data-photo]').forEach((button) => { button.addEventListener('click', () => openPhoto(Number(button.dataset.photo))) })
document.querySelectorAll('[data-open]').forEach((button) => { button.addEventListener('click', () => openPhoto(Number(button.dataset.open))) })
$('#zoom-photo').addEventListener('click', () => setZoom(!zoomed))
$('#close-viewer').addEventListener('click', () => viewer.close())
viewer.addEventListener('close', () => { document.body.append(cursor); setZoom(false); refreshTarget() })
function stepPhoto(step) { photoIndex = (photoIndex + step + photos.length) % photos.length; renderPhoto() }
$('#previous-photo').addEventListener('click', () => stepPhoto(-1))
$('#next-photo').addEventListener('click', () => stepPhoto(1))
viewer.addEventListener('keydown', (event) => {
  if (zoomed) return
  if (event.key === 'ArrowRight') { event.preventDefault(); stepPhoto(1) }
  if (event.key === 'ArrowLeft') { event.preventDefault(); stepPhoto(-1) }
})
viewer.addEventListener('click', (event) => {
  if (event.target !== viewer) return
  const bounds = viewer.getBoundingClientRect()
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) viewer.close()
})
applySettings()
