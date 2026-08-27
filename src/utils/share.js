function currentPageUrl() {
    if (typeof window === 'undefined') return ''
    return `${window.location.origin}${window.location.pathname}${window.location.search}`
}

function photoUrl(pathname, photoId) {
    if (typeof window === 'undefined' || !pathname || !photoId) return ''
    const url = new URL(pathname, window.location.origin)
    url.searchParams.set('photo', String(photoId))
    return url.toString()
}

export function shareUrlForAlbumPhoto(albumId, photoId) {
    if (!albumId) return ''
    const pathname = `/album/${encodeURIComponent(String(albumId))}`
    return photoId ? photoUrl(pathname, photoId) : new URL(pathname, window.location.origin).toString()
}

export function shareUrlForPathPhoto(pathname, photoId) {
    return photoUrl(pathname, photoId)
}

async function copyText(value) {
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value)
        return
    }

    const textarea = document.createElement('textarea')
    textarea.value = value
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const copied = document.execCommand('copy')
    textarea.remove()
    if (!copied) throw new Error('This browser could not copy the link.')
}

export async function sharePage({ title = 'Ian Truong Photography', text = '', url = currentPageUrl() } = {}) {
    if (!url) throw new Error('This page does not have a shareable link.')
    const data = { title, url }
    if (text) data.text = text

    if (typeof navigator.share === 'function') {
        try {
            await navigator.share(data)
            return 'shared'
        } catch (error) {
            if (error?.name === 'AbortError') return 'cancelled'
            // A few browsers expose navigator.share but reject otherwise-valid
            // URL shares. Copying the same safe page URL remains useful.
        }
    }

    await copyText(url)
    return 'copied'
}

export function shareUrlForCurrentPage() {
    return currentPageUrl()
}
