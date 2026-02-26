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

// Fetch all public albums for the home page
export function fetchAlbums() {
    return apiFetch('/albums')
}

// Fetch albums with filters (admin use)
export function fetchAlbumsFiltered(params = {}) {
    const query = new URLSearchParams(params).toString()
    return apiFetch(`/albums?${query}`)
}

// Fetch a single album's metadata and image list
export function fetchAlbum(albumId, token = null) {
    const options = token ? { headers: authHeaders(token) } : {}
    return apiFetch(`/albums/${albumId}`, options)
}

// ─── Protected Endpoints ───

// Request a presigned upload URL
export function requestUploadUrl(token, filename, contentType) {
    return apiFetch('/upload-url', {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ filename, contentType }),
    })
}

// Upload a file directly to S3 using a presigned URL
export async function uploadFileToS3(presignedUrl, file) {
    const res = await fetch(presignedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
    })
    if (!res.ok) throw new Error(`S3 upload failed: ${res.status}`)
    return res
}

// Create a new album record in DynamoDB
export function createAlbum(token, albumData) {
    return apiFetch('/albums', {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify(albumData),
    })
}

// Update album title/description
export function updateAlbum(token, albumId, data) {
    return apiFetch(`/albums/${albumId}`, {
        method: 'PUT',
        headers: authHeaders(token),
        body: JSON.stringify(data),
    })
}

// Delete an album and all its images
export function deleteAlbum(token, albumId) {
    return apiFetch(`/albums/${albumId}`, {
        method: 'DELETE',
        headers: authHeaders(token),
    })
}

// Delete specific images from an album
export function deleteImages(token, albumId, keys) {
    return apiFetch(`/albums/${albumId}/delete-images`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ keys }),
    })
}

// Create a new Cognito user (admin only)
export function createUser(token, email, password) {
    return apiFetch('/users', {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ email, password }),
    })
}

// List all Cognito users (admin only)
export function listUsers(token) {
    return apiFetch('/users', {
        method: 'GET',
        headers: authHeaders(token),
    })
}

// Delete a user + cascade delete their albums and photos (admin only)
export function deleteUser(token, email) {
    return apiFetch(`/users/${encodeURIComponent(email)}`, {
        method: 'DELETE',
        headers: authHeaders(token),
    })
}

// Edit a user's email and/or password (admin only)
export function editUser(token, email, data) {
    return apiFetch(`/users/${encodeURIComponent(email)}`, {
        method: 'PUT',
        headers: authHeaders(token),
        body: JSON.stringify(data),
    })
}
