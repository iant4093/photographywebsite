// Admin pages that present photographs exactly like the public galleries keep
// the gallery page styling and scroll motion instead of the admin chrome.
const GALLERY_ADMIN_PATHS = new Set(['/admin/raw-photos'])

export function usesAdminChrome(pathname) {
    return pathname.startsWith('/admin') && !GALLERY_ADMIN_PATHS.has(pathname)
}
