import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../context/auth'
import { fetchHeroReelStatus, publishHeroReel, requestHeroReelDraft } from '../utils/videoHeroApi'
import './HeroReelManager.css'

export const HERO_REEL_POLL_MS = 4000
const ACTIVE = new Set(['queued', 'running'])
const REASONS = {
    not_enough_footage: 'There was not enough calm footage in your public videos to build a reel. Publish a few more videos and try again.',
    no_ready_videos: 'None of your public videos have finished processing yet. Try again in a few minutes.',
    sources_changed: 'A video used in this draft is no longer public, so it was not published. Generate a new draft.',
    draft_missing: 'That draft is no longer available. Generate a new one.',
}
const GENERIC_FAILURE = 'The video could not be generated this time. Please try again.'

function formatDate(value) {
    const date = value ? new Date(value) : null
    return date && !Number.isNaN(date.getTime())
        ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
        : ''
}

function describe(record) {
    if (!record) return ''
    const parts = []
    if (record.duration) parts.push(`${Math.round(record.duration)} seconds`)
    if (record.clipCount) parts.push(`${record.clipCount} clips from ${record.sourceCount} ${record.sourceCount === 1 ? 'video' : 'videos'}`)
    return parts.join(' · ')
}

function pickRendition(record, view) {
    const renditions = record?.renditions || []
    const portrait = renditions.filter(item => item.height > item.width)
    const landscape = renditions.filter(item => item.width >= item.height).sort((a, b) => b.width - a.width)
    return view === 'phone' ? (portrait[0] || landscape[0]) : (landscape[0] || portrait[0])
}

function ReelPreview({ record, label }) {
    const [view, setView] = useState('desktop')
    const rendition = pickRendition(record, view)
    if (!rendition) return null
    const phone = view === 'phone'
    return (
        <div>
            <div className="mb-3 flex gap-2" role="group" aria-label={`${label} preview size`}>
                {['desktop', 'phone'].map((option) => (
                    <button
                        key={option}
                        type="button"
                        aria-pressed={view === option}
                        onClick={() => setView(option)}
                        className={`px-4 py-2 text-xs font-medium uppercase tracking-wider border border-warm-border transition-colors ${
                            view === option ? 'bg-charcoal text-cream' : 'bg-transparent text-charcoal hover:bg-cream-dark'
                        }`}
                    >
                        {option === 'desktop' ? 'Desktop' : 'Phone'}
                    </button>
                ))}
            </div>
            <div className={`hero-reel-preview overflow-hidden rounded-2xl bg-charcoal${phone ? ' is-phone' : ''}`}>
                <video
                    key={rendition.url}
                    src={rendition.url}
                    poster={record.posterUrl || undefined}
                    aria-label={`${label} (${phone ? 'phone' : 'desktop'} version)`}
                    className="h-full w-full object-cover"
                    muted
                    loop
                    autoPlay
                    playsInline
                    preload="metadata"
                />
            </div>
        </div>
    )
}

// Admin controls for the Video page hero: the reel rebuilds itself after new
// public videos, and can be regenerated, previewed, and published by hand.
export default function HeroReelManager() {
    const { getIdToken } = useAuth()
    const [state, setState] = useState(null)
    const [loading, setLoading] = useState(true)
    const [sending, setSending] = useState(false)
    const [error, setError] = useState('')
    const [notice, setNotice] = useState('')
    const lastJobRef = useRef(null)

    const applyStatus = useCallback((next) => {
        setState(next)
        setLoading(false)
        const job = next?.job
        const previous = lastJobRef.current
        lastJobRef.current = job
        if (!job || !previous || previous.requestId !== job.requestId || !ACTIVE.has(previous.status)) return
        if (job.status === 'failed') setError(REASONS[job.reason] || GENERIC_FAILURE)
        if (job.status === 'ready') setNotice('Your new reel is ready to preview below.')
        if (job.status === 'published') setNotice('The new reel is live on the Video page.')
    }, [])
    const loadStatus = useCallback(
        async (signal) => fetchHeroReelStatus(await getIdToken(), { signal }),
        [getIdToken],
    )

    const jobActive = ACTIVE.has(state?.job?.status)

    useEffect(() => {
        const controller = new AbortController()
        loadStatus(controller.signal).then(applyStatus, (requestError) => {
            if (requestError?.name === 'AbortError') return
            setLoading(false)
            setError(requestError?.message || 'The hero video status could not be loaded.')
        })
        return () => controller.abort()
    }, [applyStatus, loadStatus])

    useEffect(() => {
        if (!jobActive) return undefined
        const controller = new AbortController()
        const timer = window.setInterval(() => {
            loadStatus(controller.signal).then(applyStatus, () => {})
        }, HERO_REEL_POLL_MS)
        return () => {
            window.clearInterval(timer)
            controller.abort()
        }
    }, [applyStatus, jobActive, loadStatus])

    async function send(action) {
        setSending(true)
        setError('')
        setNotice('')
        try {
            const token = await getIdToken()
            const response = action === 'publish'
                ? await publishHeroReel(token, state.draft.version)
                : await requestHeroReelDraft(token)
            lastJobRef.current = response.job
            setState(current => ({ ...current, job: response.job }))
        } catch (requestError) {
            setError(requestError?.message || 'The request could not be sent.')
        } finally {
            setSending(false)
        }
    }

    const { job, draft, published, auto } = state || {}
    const publishing = jobActive && job.mode === 'publish'
    const generating = jobActive && !publishing
    const draftIsNew = draft && draft.version !== published?.version

    return (
        <div id="hero-cover-panel" role="tabpanel" className="bg-white rounded-2xl p-6 md:p-8 shadow-warm-lg border border-warm-border">
            <p className="mb-6 text-sm text-warm-gray leading-relaxed">
                The Video page hero is a silent, looping reel of about a minute, spliced automatically from calm moments in
                your public videos. It rebuilds on its own within a day of you publishing new videos. Regenerate it any time for a fresh
                cut, preview it, then publish.
            </p>

            {error && (
                <div className="mb-6 p-4 rounded-xl bg-red-50 border border-red-200 text-red-700" role="alert">{error}</div>
            )}
            {notice && (
                <div className="mb-6 p-4 rounded-xl bg-green-50 border border-green-200 text-green-800" role="status">{notice}</div>
            )}

            <section aria-labelledby="hero-reel-live" className="mb-8">
                <h2 id="hero-reel-live" className="mb-3 font-serif text-2xl text-charcoal">Live now</h2>
                {loading ? (
                    <p className="text-sm text-warm-gray">Loading…</p>
                ) : published ? (
                    <>
                        <ReelPreview record={published} label="Live hero video" />
                        <p className="mt-3 text-sm text-warm-gray">
                            {[formatDate(published.publishedAt) && `Published ${formatDate(published.publishedAt)}`, published.mode === 'auto' ? 'built automatically' : '', describe(published)].filter(Boolean).join(' · ')}
                        </p>
                    </>
                ) : (
                    <p className="text-sm text-warm-gray">No reel is published yet, so the Video page shows its still image.</p>
                )}
                {auto?.status === 'failed' && (
                    <p className="mt-2 text-sm text-amber-dark">The last automatic rebuild did not finish: {REASONS[auto.reason] || GENERIC_FAILURE}</p>
                )}
            </section>

            {draftIsNew && !generating && (
                <section aria-labelledby="hero-reel-draft" className="mb-8 border-t border-warm-border pt-8">
                    <h2 id="hero-reel-draft" className="mb-3 font-serif text-2xl text-charcoal">New draft</h2>
                    <ReelPreview record={draft} label="Draft hero video" />
                    <p className="mt-3 text-sm text-warm-gray">
                        {[formatDate(draft.createdAt) && `Generated ${formatDate(draft.createdAt)}`, describe(draft)].filter(Boolean).join(' · ')}
                    </p>
                    <button
                        type="button"
                        onClick={() => send('publish')}
                        disabled={sending || jobActive}
                        className="mt-5 w-full rounded-xl bg-charcoal px-6 py-3 font-medium text-cream transition-colors hover:bg-charcoal-light disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {publishing ? 'Publishing…' : 'Publish this reel'}
                    </button>
                </section>
            )}

            {jobActive && (
                <p className="mb-4 text-sm text-warm-gray" role="status" aria-live="polite">
                    {publishing
                        ? 'Publishing the new reel…'
                        : 'Generating a new reel from your videos. This usually takes a few minutes; you can leave this page and come back.'}
                </p>
            )}
            <button
                type="button"
                onClick={() => send('generate')}
                disabled={loading || sending || jobActive}
                className="w-full rounded-xl bg-amber px-6 py-3 font-medium text-white shadow-warm transition-colors hover:bg-amber-dark disabled:cursor-not-allowed disabled:opacity-50"
            >
                {generating ? 'Generating…' : 'Regenerate video'}
            </button>
        </div>
    )
}
