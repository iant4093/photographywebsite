export const EXPOSURE_GROUPS = Object.freeze([
    {
        id: 'aperture',
        label: 'Aperture',
        read: image => parseAperture(image?.exif?.focalRatio),
        options: [
            { id: 'wide', label: 'Wide open', detail: 'f/1–f/2.8', matches: value => value > 0 && value <= 2.8 },
            { id: 'middle', label: 'Balanced', detail: 'f/3.2–f/7.1', matches: value => value > 2.8 && value <= 7.1 },
            { id: 'deep', label: 'Deep focus', detail: 'f/8+', matches: value => value > 7.1 },
        ],
    },
    {
        id: 'shutter',
        label: 'Shutter speed',
        read: image => parseShutterSeconds(image?.exif?.shutterSpeed),
        options: [
            { id: 'motion', label: 'Motion', detail: '1/60s or slower', matches: value => value >= (1 / 60) },
            { id: 'handheld', label: 'Handheld', detail: '1/80s–1/320s', matches: value => value < (1 / 60) && value >= (1 / 320) },
            { id: 'frozen', label: 'Frozen action', detail: '1/400s or faster', matches: value => value > 0 && value < (1 / 320) },
        ],
    },
    {
        id: 'iso',
        label: 'ISO',
        read: image => parseIso(image?.exif?.iso),
        options: [
            { id: 'clean', label: 'Clean light', detail: 'ISO 50–200', matches: value => value > 0 && value <= 200 },
            { id: 'available', label: 'Available light', detail: 'ISO 250–800', matches: value => value > 200 && value <= 800 },
            { id: 'low', label: 'Low light', detail: 'ISO 1000+', matches: value => value > 800 },
        ],
    },
    {
        id: 'focal',
        label: 'Focal length',
        read: image => parseFocalLength(image?.exif?.focalLength),
        options: [
            { id: 'wide', label: 'Wide', detail: '12–24mm', matches: value => value > 0 && value <= 24 },
            { id: 'normal', label: 'Normal', detail: '25–70mm', matches: value => value > 24 && value <= 70 },
            { id: 'telephoto', label: 'Telephoto', detail: '71mm+', matches: value => value > 70 },
        ],
    },
])

const QUIZ_FIELDS = Object.freeze([
    { id: 'aperture', prompt: 'Which aperture made this photograph?', read: image => image?.exif?.focalRatio, defaults: ['f/1.4', 'f/2.8', 'f/5.6', 'f/8', 'f/11'] },
    { id: 'shutter', prompt: 'Which shutter speed made this photograph?', read: image => image?.exif?.shutterSpeed, defaults: ['1/30s', '1/125s', '1/500s', '1/1000s', '1/4000s'] },
    { id: 'iso', prompt: 'Which ISO made this photograph?', read: image => image?.exif?.iso, defaults: ['ISO 100', 'ISO 400', 'ISO 800', 'ISO 1600', 'ISO 3200'] },
    { id: 'focal', prompt: 'Which focal length made this photograph?', read: image => image?.exif?.focalLength, defaults: ['17mm', '33mm', '56mm', '100mm', '400mm'] },
])

function numberFrom(value) {
    const match = String(value || '').replace(',', '').match(/(?:^|\s)(\d+(?:\.\d+)?)/)
        || String(value || '').replace(',', '').match(/(\d+(?:\.\d+)?)/)
    return match ? Number(match[1]) : 0
}

export function parseAperture(value) {
    return numberFrom(value)
}

export function parseIso(value) {
    return numberFrom(value)
}

export function parseFocalLength(value) {
    return numberFrom(value)
}

export function parseShutterSeconds(value) {
    const normalized = String(value || '').trim().toLowerCase().replace(/seconds?|secs?|s$/g, '').trim()
    const fraction = normalized.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/)
    if (fraction) {
        const denominator = Number(fraction[2])
        return denominator > 0 ? Number(fraction[1]) / denominator : 0
    }
    const numeric = Number(normalized)
    return Number.isFinite(numeric) && numeric > 0 ? numeric : 0
}

export function matchingExposurePhotos(images, groupId, optionId) {
    const group = EXPOSURE_GROUPS.find(candidate => candidate.id === groupId)
    const option = group?.options.find(candidate => candidate.id === optionId)
    if (!group || !option) return []
    return images.filter(image => option.matches(group.read(image)))
}

export function hasCompleteSettings(image) {
    const exif = image?.exif
    return Boolean(
        parseAperture(exif?.focalRatio)
        && parseShutterSeconds(exif?.shutterSpeed)
        && parseIso(exif?.iso)
        && parseFocalLength(exif?.focalLength),
    )
}

function shuffled(values, random) {
    const result = [...values]
    for (let index = result.length - 1; index > 0; index -= 1) {
        const target = Math.floor(random() * (index + 1))
        ;[result[index], result[target]] = [result[target], result[index]]
    }
    return result
}

export function buildSettingsRound(images, previousId = '', random = Math.random) {
    const eligible = images.filter(hasCompleteSettings)
    if (!eligible.length) return null
    const alternatives = eligible.filter(image => (image.mediaId || image.id || image.url) !== previousId)
    const candidates = alternatives.length ? alternatives : eligible
    const image = candidates[Math.floor(random() * candidates.length)]
    const field = QUIZ_FIELDS[Math.floor(random() * QUIZ_FIELDS.length)]
    const answer = String(field.read(image) || '').trim()
    const observed = eligible.map(candidate => String(field.read(candidate) || '').trim()).filter(Boolean)
    const distractors = shuffled([...new Set([...observed, ...field.defaults].filter(value => value !== answer))], random).slice(0, 3)
    const options = shuffled([answer, ...distractors], random)
    return { image, field: field.id, prompt: field.prompt, answer, options }
}
