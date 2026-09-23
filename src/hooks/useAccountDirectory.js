import { useCallback, useEffect, useRef, useState } from 'react'
import { listUsersPage } from '../utils/api'

// One request at a time; first-page results render while the directory completes.
export default function useAccountDirectory(getIdToken) {
    const [users, setUsers] = useState([])
    const [loading, setLoading] = useState(true)
    const [listError, setListError] = useState('')
    const active = useRef(null)
    const loadUsers = useCallback(async () => {
        active.current?.abort()
        const controller = new AbortController()
        active.current = controller
        setLoading(true)
        setListError('')
        try {
            const token = await getIdToken()
            const collected = new Map()
            const seen = new Set()
            let cursor = null
            for (let page = 0; page < 200; page += 1) {
                if (controller.signal.aborted) return
                const result = await listUsersPage(token, { cursor, limit: 60 }, { signal: controller.signal })
                if (controller.signal.aborted) return
                for (const user of result.users) {
                    if (user.email !== 'iant4093@gmail.com') collected.set(user.sub || user.email, user)
                }
                setUsers([...collected.values()])
                cursor = result.nextCursor
                if (!cursor) return
                if (seen.has(cursor)) throw new Error('The account directory returned a repeated page.')
                seen.add(cursor)
            }
            throw new Error('The account directory exceeded its loading limit.')
        } catch (error) {
            if (!controller.signal.aborted) setListError(`${error.message || 'Unable to load accounts.'} Results may be incomplete. Please retry.`)
        } finally {
            if (!controller.signal.aborted) setLoading(false)
        }
    }, [getIdToken])
    useEffect(() => {
        const timer = setTimeout(loadUsers, 0)
        return () => { clearTimeout(timer); active.current?.abort() }
    }, [loadUsers])
    return { users, loading, listError, loadUsers }
}
