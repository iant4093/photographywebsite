// API base URL
const API_BASE = import.meta.env.VITE_API_BASE_URL || 'https://your-api-id.execute-api.us-west-2.amazonaws.com'

// Generic fetch wrapper with optional auth header
async function apiFetch(path, options = {}) {
    const url = `${API_BASE}${path}`
    try {
        const res = await fetch(url, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...options.headers,
            },
        })
        if (!res.ok) {
            const body = await res.text()
            throw new Error(`API error ${res.status}: ${body}`)
        }
        return res.json()
    } catch (err) {
        console.error(`[API] ${options.method || 'GET'} ${url} failed:`, err)
        throw err
    }
}

// Auth header helper
function authHeaders(token) {
    return { Authorization: `Bearer ${token}` }
}

// ─── Public Endpoints ───

/**
 * Fetch all public albums for the home page.
 * @returns {Promise<Array>} Array of public albums.
 */
export function fetchAlbums() {
    return apiFetch('/albums')
}

/**
 * Fetch albums with filters (admin use).
 * @param {Object} params - Query parameters (e.g., visibility, limit).
 * @returns {Promise<Array>} Array of filtered albums.
 */
export function fetchAlbumsFiltered(params = {}) {
    const query = new URLSearchParams(params).toString()
    return apiFetch(`/albums?${query}`)
}

/**
 * Fetch a single album's metadata and image list.
 * @param {string} albumId - The ID of the album to fetch.
 * @param {string|null} token - Optional auth token for private albums.
 * @returns {Promise<Object>} Album metadata and images.
 */
export function fetchAlbum(albumId, token = null) {
    const options = token ? { headers: authHeaders(token) } : {}
    return apiFetch(`/albums/${albumId}`, options)
}

/**
 * Fetch a shared album by its unique code (no auth required).
 * @param {string} shareCode - The unique share code.
 * @param {string} turnstileToken - Cloudflare Turnstile token for verification.
 * @returns {Promise<Object>} Shared album metadata and images.
 */
export function fetchSharedAlbum(shareCode, turnstileToken) {
    return apiFetch(`/shared/${shareCode}`, {
        headers: { 'X-Turnstile-Token': turnstileToken || '' }
    })
}

// ─── Protected Endpoints ───

/**
 * Request presigned upload URLs for files.
 * @param {string} token - Auth token.
 * @param {string} filename - Name of the file.
 * @param {string} contentType - MIME type of the file.
 * @returns {Promise<Object>} Presigned URL data.
 */
export function requestUploadUrl(token, filename, contentType) {
    return apiFetch('/upload-url', {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ filename, contentType }),
    })
}

/**
 * Upload a file directly to S3 using a presigned URL.
 * @param {string} presignedUrl - The S3 presigned URL.
 * @param {File} file - The file object to upload.
 * @returns {Promise<Response>} Fetch response.
 */
export async function uploadFileToS3(presignedUrl, file) {
    const res = await fetch(presignedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
    })
    if (!res.ok) throw new Error(`S3 upload failed: ${res.status}`)
    return res
}

/**
 * Create a new album record in DynamoDB.
 * @param {string} token - Auth token.
 * @param {Object} albumData - Data for the new album.
 * @returns {Promise<Object>} Created album data.
 */
export function createAlbum(token, albumData) {
    return apiFetch('/albums', {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify(albumData),
    })
}

/**
 * Update album title, description, or visibility.
 * @param {string} token - Auth token.
 * @param {string} albumId - ID of the album to update.
 * @param {Object} data - Updated album data.
 * @returns {Promise<Object>} Updated album data.
 */
export function updateAlbum(token, albumId, data) {
    return apiFetch(`/albums/${albumId}`, {
        method: 'PUT',
        headers: authHeaders(token),
        body: JSON.stringify(data),
    })
}

/**
 * Add new images to an existing album.
 * @param {string} token - Auth token.
 * @param {string} albumId - ID of the album.
 * @param {Array} images - Array of image objects to add.
 * @returns {Promise<Object>} Updated album data.
 */
export function addImagesToAlbum(token, albumId, images) {
    return apiFetch(`/albums/${albumId}/images`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ images }),
    })
}

/**
 * Delete an album and all its associated images.
 * @param {string} token - Auth token.
 * @param {string} albumId - ID of the album to delete.
 * @returns {Promise<Object>} Deletion confirmation.
 */
export function deleteAlbum(token, albumId) {
    return apiFetch(`/albums/${albumId}`, {
        method: 'DELETE',
        headers: authHeaders(token),
    })
}

/**
 * Delete specific images from an album.
 * @param {string} token - Auth token.
 * @param {string} albumId - ID of the album.
 * @param {Array<string>} keys - Array of S3 keys of images to delete.
 * @returns {Promise<Object>} Deletion confirmation.
 */
export function deleteImages(token, albumId, keys) {
    return apiFetch(`/albums/${albumId}/delete-images`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ keys }),
    })
}

/**
 * Update an individual image's thumbKey and blurhash (for video thumbnail re-generation).
 * @param {string} token - Auth token.
 * @param {string} albumId - ID of the album.
 * @param {string} rawKey - The raw S3 key of the image/video.
 * @param {Object} data - New thumbnail data (thumbKey, blurhash).
 * @returns {Promise<Object>} Update confirmation.
 */
export function updateImageThumbnail(token, albumId, rawKey, data) {
    return apiFetch(`/albums/${albumId}/images`, {
        method: 'PATCH',
        headers: authHeaders(token),
        body: JSON.stringify({ rawKey, ...data }),
    })
}

/**
 * Create a new Cognito user (admin only).
 * @param {string} token - Auth token.
 * @param {string} email - New user email.
 * @param {string} password - New user password.
 * @returns {Promise<Object>} Created user data.
 */
export function createUser(token, email, password) {
    return apiFetch('/users', {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ email, password }),
    })
}

/**
 * List all Cognito users (admin only).
 * @param {string} token - Auth token.
 * @returns {Promise<Array>} Array of users.
 */
export async function listUsers(token) {
    const data = await apiFetch('/users', {
        method: 'GET',
        headers: authHeaders(token),
    })
    return data.users || data
}

/**
 * Delete a user and cascade delete their albums and photos (admin only).
 * @param {string} token - Auth token.
 * @param {string} email - Email of the user to delete.
 * @returns {Promise<Object>} Deletion confirmation.
 */
export function deleteUser(token, email) {
    return apiFetch(`/users/${encodeURIComponent(email)}`, {
        method: 'DELETE',
        headers: authHeaders(token),
    })
}

/**
 * Edit a user's email and/or password (admin only).
 * @param {string} token - Auth token.
 * @param {string} email - Current email of the user.
 * @param {Object} data - Updated user data (newEmail, newPassword).
 * @returns {Promise<Object>} Update confirmation.
 */
export function editUser(token, email, data) {
    return apiFetch(`/users/${encodeURIComponent(email)}`, {
        method: 'PUT',
        headers: authHeaders(token),
        body: JSON.stringify(data),
    })
}
