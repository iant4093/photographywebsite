// Account administration is loaded only when an administrator opens these controls.
export function createUser(services, token, email, options = {}) {
    const { apiFetch, authHeaders } = services
    return apiFetch('/users', {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ email }),
        signal: options.signal,
    })
}

export async function listUsersPage(services, token, params = {}, options = {}) {
    const { apiFetch, authHeaders } = services
    const queryParams = new URLSearchParams()
    if (params.limit) queryParams.set('limit', String(params.limit))
    if (params.cursor) queryParams.set('paginationToken', String(params.cursor))
    if (params.search) queryParams.set('search', String(params.search))
    const query = queryParams.toString()
    const payload = await apiFetch(`/users${query ? `?${query}` : ''}`, {
        headers: authHeaders(token),
        signal: options.signal,
    })
    if (Array.isArray(payload)) return { users: payload, nextCursor: null }
    return {
        users: Array.isArray(payload?.users) ? payload.users : [],
        nextCursor: payload?.paginationToken || payload?.nextCursor || null,
    }
}

export async function listUsers(services, token, options = {}) {
    const { ApiError } = services
    const users = []
    const seenCursors = new Set()
    let cursor = null
    do {
        const page = await listUsersPage(services, token, {
            cursor,
            limit: options.limit,
            search: options.search,
        }, options)
        users.push(...page.users)
        cursor = page.nextCursor
        if (cursor && seenCursors.has(cursor)) {
            throw new ApiError('The service returned an invalid pagination sequence.', {
                code: 'REPEATED_CURSOR',
            })
        }
        if (cursor) seenCursors.add(cursor)
    } while (cursor)
    return users
}

export function deleteUser(services, token, email, options = {}) {
    const { albumMutation, authHeaders } = services
    return albumMutation(`/users/${encodeURIComponent(email)}`, {
        method: 'DELETE',
        headers: authHeaders(token),
        ...(options.userId ? { body: JSON.stringify({ userId: options.userId }) } : {}),
        signal: options.signal,
    }, { timeoutMs: 60_000, missingAfterPending: true })
}

export function editUser(services, token, email, data, options = {}) {
    const { albumMutation, authHeaders } = services
    return albumMutation(`/users/${encodeURIComponent(email)}`, {
        method: 'PUT',
        headers: authHeaders(token),
        body: JSON.stringify(data),
        signal: options.signal,
    })
}
