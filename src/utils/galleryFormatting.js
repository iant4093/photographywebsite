const dateOptions = { year: 'numeric', month: 'long', day: 'numeric' }
const albumDateFormatter = new Intl.DateTimeFormat('en-US', dateOptions)
const titleCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

export function formatAlbumDate(value) {
    const date = new Date(value)
    // Keep the existing displayed fallback for malformed legacy dates.
    return Number.isNaN(date.getTime())
        ? date.toLocaleDateString('en-US', dateOptions)
        : albumDateFormatter.format(date)
}

export function compareGalleryTitles(left, right) {
    return titleCollator.compare(left, right)
}
