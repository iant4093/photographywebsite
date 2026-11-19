import { cdnDomain } from './mediaUrls'

const ORDER_PAGE = 'https://www.pictorem.com/order.html'
const PRO_ID = 'HQ1RAJ10HOD'
const MEDIA_ORIGIN = `https://${cdnDomain || 'd1twwtwfz1yeo4.cloudfront.net'}`
const PRINT_SOURCE_EXTENSION = /\.(jpe?g|png)$/i

function printImageUrl(value) {
    if (typeof value !== 'string') return null
    try {
        const image = new URL(value)
        if (image.protocol === 'https:' && !image.username && !image.password
            && !image.hash && PRINT_SOURCE_EXTENSION.test(image.pathname)) return image
    } catch { /* Invalid media URL. */ }
    return null
}

function orderUrl(image) {
    const checkout = new URL(ORDER_PAGE)
    checkout.searchParams.set('apiid', PRO_ID)
    checkout.searchParams.set('import', image.href)
    return checkout.href
}

export function pictoremOrderUrl(photo) {
    // This field is provided only for public media. Never fall back to a
    // display preview, a signed download or the camera-original comparison.
    if (photo?.freshDownloadRequired) return ''
    const image = printImageUrl(photo?.downloadUrl)
    if (!image || image.origin !== MEDIA_ORIGIN || image.search || !image.pathname.startsWith('/albums/')) return ''
    return orderUrl(image)
}

export function canPrintProtectedPhoto(photo) {
    // The gallery's primary URL identifies the file format only. The actual
    // handoff must get a fresh, single-file link from the authorized endpoint.
    return Boolean(photo?.freshDownloadRequired && printImageUrl(photo.url))
}

export function pictoremProtectedOrderUrl(printSourceUrl) {
    const image = printImageUrl(printSourceUrl)
    if (!image || !image.hostname.endsWith('.amazonaws.com') || !image.pathname.includes('/albums/')
        || !image.searchParams.has('X-Amz-Signature')) return ''
    return orderUrl(image)
}
