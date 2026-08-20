import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { fetchAlbums, fetchPhotographyStats } from '../utils/api'
import { formatBytes } from '../utils/formatBytes'
import { albumCoverUrl } from '../utils/mediaUrls'
import ProgressiveImage from '../components/ProgressiveImage'
import './Stats.css'


const numberFormatter = new Intl.NumberFormat('en-US')
const timelineMonthFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' })
const DAY_MS = 24 * 60 * 60 * 1000
const TIMELINE_REM_PER_DAY = 2.25
const TIMELINE_MIN_POINT_GAP_REM = 18.5
const TIMELINE_EDGE_PADDING_REM = 11

function number(value) {
    const parsed = Number(value)
    return numberFormatter.format(Number.isFinite(parsed) ? parsed : 0)
}

function dateLabel(value) {
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) return 'recently'
    return new Intl.DateTimeFormat('en-US', {
        month: 'long', day: 'numeric', year: 'numeric',
    }).format(parsed)
}

function StatCard({ index, label, value }) {
    return (
        <article className="photo-stats-card">
            <span className="photo-stats-card-index" aria-hidden="true">{String(index).padStart(2, '0')}</span>
            <p className="photo-stats-eyebrow">{label}</p>
            <p className="photo-stats-value">{value}</p>
        </article>
    )
}

function KeptMeter({ label, kept, taken, percent }) {
    const bounded = Math.max(0, Math.min(100, Number(percent) || 0))
    return (
        <article className="photo-stats-kept-card">
            <div className="photo-stats-kept-heading">
                <div>
                    <p className="photo-stats-eyebrow">{label}</p>
                    <p className="photo-stats-kept-value">{bounded.toFixed(1)}%</p>
                </div>
                <p className="photo-stats-kept-ratio">{number(kept)} of {number(taken)}</p>
            </div>
            <div
                className="photo-stats-meter"
                role="progressbar"
                aria-label={`${label}: ${bounded.toFixed(1)} percent`}
                aria-valuemin="0"
                aria-valuemax="100"
                aria-valuenow={bounded}
            >
                <span style={{ width: `${bounded}%` }} />
            </div>
        </article>
    )
}

function SectionHeading({ id, index, eyebrow, title, detail }) {
    return (
        <div className="photo-stats-section-heading">
            <p className="photo-stats-section-index">{String(index).padStart(2, '0')}</p>
            <div>
                <p className="photo-stats-eyebrow">{eyebrow}</p>
                <h2 id={id}>{title}</h2>
            </div>
            {detail && <p className="photo-stats-section-detail">{detail}</p>}
        </div>
    )
}

function GearList({ title, items }) {
    return (
        <section className="photo-stats-gear-list" aria-labelledby={`gear-${title.toLowerCase()}`}>
            <h3 id={`gear-${title.toLowerCase()}`}>{title}</h3>
            <ol>
                {items.map((item, index) => (
                    <li key={item.name}>
                        <span className="photo-stats-gear-rank">{String(index + 1).padStart(2, '0')}</span>
                        <span className="photo-stats-gear-name">{item.name}</span>
                        <span className="photo-stats-gear-count">{number(item.photos)} photos</span>
                    </li>
                ))}
            </ol>
        </section>
    )
}

function albumTimestamp(album) {
    const timestamp = Date.parse(album?.createdAt || '')
    return Number.isFinite(timestamp) ? timestamp : 0
}

function albumRoute(album) {
    return `/${album?.type === 'video' ? 'video' : 'album'}/${album?.albumId}`
}

function timelineDate(value) {
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) return 'Date unavailable'
    return new Intl.DateTimeFormat('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
    }).format(parsed)
}

function timelineCalendarDay(value) {
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) return null
    const parts = [
        parsed.getFullYear(),
        String(parsed.getMonth() + 1).padStart(2, '0'),
        String(parsed.getDate()).padStart(2, '0'),
    ]
    return {
        key: parts.join('-'),
        ordinal: Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()) / DAY_MS,
        year: parsed.getFullYear(),
        month: parsed.getMonth(),
    }
}

function timelineMonthStartOrdinal(year, month) {
    return Date.UTC(year, month, 1) / DAY_MS
}

function timelinePositionForOrdinal(groups, ordinal) {
    if (groups.length === 0) return 0
    if (ordinal >= groups[0].ordinal) return groups[0].x
    if (ordinal <= groups[groups.length - 1].ordinal) return groups[groups.length - 1].x

    for (let index = 0; index < groups.length - 1; index += 1) {
        const newer = groups[index]
        const older = groups[index + 1]
        if (ordinal > newer.ordinal || ordinal < older.ordinal) continue
        const daySpan = newer.ordinal - older.ordinal
        if (daySpan <= 0) return newer.x
        const progress = (newer.ordinal - ordinal) / daySpan
        return newer.x + progress * (older.x - newer.x)
    }
    return groups[groups.length - 1].x
}

function buildTimelineLayout(groups) {
    if (groups.length === 0) return { groups: [], months: [], years: [], stageWidth: 0 }

    let previousOrdinal = null
    let x = 0
    const positionedGroups = groups.map((group, index) => {
        const ordinal = Number.isFinite(group.ordinal)
            ? group.ordinal
            : (previousOrdinal === null ? -index : previousOrdinal - 1)
        if (previousOrdinal !== null) {
            const elapsedDays = Math.max(previousOrdinal - ordinal, 1)
            x += Math.max(
                TIMELINE_MIN_POINT_GAP_REM,
                elapsedDays * TIMELINE_REM_PER_DAY,
            )
        }
        previousOrdinal = ordinal
        return { ...group, ordinal, x }
    })

    const referenceGroups = positionedGroups.filter((group) => Number.isFinite(group.calendarOrdinal))
    const months = []
    const years = []

    if (referenceGroups.length > 0) {
        const newest = referenceGroups[0]
        const oldest = referenceGroups[referenceGroups.length - 1]

        for (
            let year = newest.year, month = newest.month;
            year > oldest.year || (year === oldest.year && month >= oldest.month);
        ) {
            const monthStart = timelineMonthStartOrdinal(year, month)
            const nextMonthStart = timelineMonthStartOrdinal(year, month + 1)
            const newerBoundary = Math.min(newest.ordinal, nextMonthStart)
            const olderBoundary = Math.max(oldest.ordinal, monthStart)
            const left = timelinePositionForOrdinal(referenceGroups, newerBoundary)
            const right = timelinePositionForOrdinal(referenceGroups, olderBoundary)
            months.push({
                key: `${year}-${String(month + 1).padStart(2, '0')}`,
                label: timelineMonthFormatter.format(new Date(Date.UTC(year, month, 15))),
                left,
                width: Math.max(right - left, 0.1),
            })

            month -= 1
            if (month < 0) {
                month = 11
                year -= 1
            }
        }

        for (let year = newest.year; year >= oldest.year; year -= 1) {
            const yearStart = timelineMonthStartOrdinal(year, 0)
            const nextYearStart = timelineMonthStartOrdinal(year + 1, 0)
            const newerBoundary = Math.min(newest.ordinal, nextYearStart)
            const olderBoundary = Math.max(oldest.ordinal, yearStart)
            const left = timelinePositionForOrdinal(referenceGroups, newerBoundary)
            const right = timelinePositionForOrdinal(referenceGroups, olderBoundary)
            years.push({
                year,
                left,
                width: Math.max(right - left, 0.1),
            })
        }
    }

    return {
        groups: positionedGroups,
        months,
        years,
        stageWidth: positionedGroups[positionedGroups.length - 1].x + (TIMELINE_EDGE_PADDING_REM * 2),
    }
}

function TimelineCard({ album, index, position }) {
    const cover = album.coverThumbnailUrl || albumCoverUrl(album)
    const [imageFailed, setImageFailed] = useState(false)
    return (
        <Link
            className="photo-stats-timeline-card"
            data-timeline-position={position}
            to={albumRoute(album)}
            aria-label={`View ${album.title}`}
        >
            <span className="photo-stats-timeline-index" aria-hidden="true">
                {String(index + 1).padStart(2, '0')}
            </span>
            <span className="photo-stats-timeline-image">
                {cover && !imageFailed ? (
                    <ProgressiveImage
                        src={cover}
                        alt=""
                        blurhash={album.coverBlurhash}
                        width={album.coverWidth || 4}
                        height={album.coverHeight || 3}
                        eager={index < 8}
                        sizes="(min-width: 768px) 288px, 72vw"
                        className="photo-stats-timeline-progressive-image"
                        onError={() => setImageFailed(true)}
                    />
                ) : (
                    <span className="photo-stats-timeline-image-fallback" aria-hidden="true">IT</span>
                )}
            </span>
            <strong>{album.title}</strong>
            <small>{album.type === 'video' ? 'Video' : 'Photo'} · {album.category || 'Uncategorized'}</small>
        </Link>
    )
}

function AlbumTimeline({ albums, loading, error, onRetry }) {
    const scrollerRef = useRef(null)
    const orderedAlbums = useMemo(() => [...albums].sort((left, right) => (
        albumTimestamp(right) - albumTimestamp(left)
        || String(left.title || '').localeCompare(String(right.title || ''))
    )), [albums])
    const timelineGroups = useMemo(() => {
        const groups = []
        const groupByDate = new Map()

        orderedAlbums.forEach((album, index) => {
            const calendarDay = timelineCalendarDay(album.createdAt)
            const key = calendarDay?.key || `unknown-${album?.albumId || index}`
            let group = groupByDate.get(key)
            if (!group) {
                group = {
                    key,
                    createdAt: album.createdAt,
                    label: timelineDate(album.createdAt),
                    calendarOrdinal: calendarDay?.ordinal,
                    ordinal: calendarDay?.ordinal,
                    year: calendarDay?.year,
                    month: calendarDay?.month,
                    albums: [],
                }
                groupByDate.set(key, group)
                groups.push(group)
            }
            group.albums.push({ album, index })
        })

        return groups
    }, [orderedAlbums])
    const timelineLayout = useMemo(() => buildTimelineLayout(timelineGroups), [timelineGroups])

    const scrollTimeline = (direction) => {
        const scroller = scrollerRef.current
        if (!scroller) return
        const nextLeft = Math.max(
            0,
            scroller.scrollLeft + direction * Math.max(scroller.clientWidth * 0.78, 280),
        )
        scroller.scrollTo({
            left: nextLeft,
            behavior: 'smooth',
        })
    }

    return (
        <section className="photo-stats-timeline-section photo-stats-motion-section" aria-labelledby="album-timeline-heading">
            <div className="photo-stats-timeline-heading">
                <h2 id="album-timeline-heading">Album Timeline</h2>
                <div className="photo-stats-timeline-controls" aria-label="Album timeline controls">
                    <button type="button" onClick={() => scrollTimeline(-1)} aria-label="Scroll timeline toward newer albums">←</button>
                    <button type="button" onClick={() => scrollTimeline(1)} aria-label="Scroll timeline toward older albums">→</button>
                </div>
            </div>

            {loading && (
                <div className="photo-stats-timeline-status" role="status">Loading the album timeline…</div>
            )}
            {!loading && error && (
                <div className="photo-stats-timeline-status photo-stats-timeline-error" role="alert">
                    <span>The album timeline could not be loaded.</span>
                    <button type="button" onClick={onRetry}>Try again</button>
                </div>
            )}
            {!loading && !error && orderedAlbums.length === 0 && (
                <p className="photo-stats-timeline-status">No public albums are available yet.</p>
            )}
            {!error && orderedAlbums.length > 0 && (
                <div className="photo-stats-timeline-shell">
                    <div
                        ref={scrollerRef}
                        className="photo-stats-timeline-scroll"
                        tabIndex={0}
                        aria-label="Public albums, newest to oldest"
                    >
                        <div
                            className="photo-stats-timeline-stage"
                            style={{ '--timeline-stage-width': `${timelineLayout.stageWidth}rem` }}
                        >
                            <div className="photo-stats-timeline-ruler" aria-hidden="true">
                                {timelineLayout.years.map((year) => (
                                    <span
                                        key={year.year}
                                        className="photo-stats-timeline-year"
                                        data-timeline-year={year.year}
                                        style={{
                                            '--timeline-period-left': `${TIMELINE_EDGE_PADDING_REM + year.left}rem`,
                                            '--timeline-period-width': `${year.width}rem`,
                                        }}
                                    >
                                        <strong>{year.year}</strong>
                                    </span>
                                ))}
                                {timelineLayout.months.map((month) => (
                                    <span
                                        key={month.key}
                                        className="photo-stats-timeline-month"
                                        data-timeline-month={month.key}
                                        style={{
                                            '--timeline-period-left': `${TIMELINE_EDGE_PADDING_REM + month.left}rem`,
                                            '--timeline-period-width': `${month.width}rem`,
                                        }}
                                    >
                                        <strong>{month.label}</strong>
                                    </span>
                                ))}
                            </div>
                            <ol className="photo-stats-timeline-track">
                                {timelineLayout.groups.map((group, groupIndex) => {
                                    const fallbackPosition = groupIndex % 2 === 0 ? 'above' : 'below'
                                    const positionedAlbums = group.albums.map((entry, index) => ({
                                        ...entry,
                                        position: group.albums.length === 1
                                            ? fallbackPosition
                                            : (index % 2 === 0 ? 'above' : 'below'),
                                    }))
                                    const above = positionedAlbums.filter(({ position }) => position === 'above')
                                    const below = positionedAlbums.filter(({ position }) => position === 'below')
                                    const columns = Math.max(above.length, below.length, 1)
                                    const groupWidth = `calc(${columns} * var(--timeline-card-width) + ${Math.max(columns - 1, 0)} * var(--timeline-group-card-gap))`
                                    return (
                                        <li
                                            key={group.key}
                                            className={`photo-stats-timeline-item is-date-${fallbackPosition}`}
                                            data-timeline-date={group.key}
                                            data-timeline-album-count={group.albums.length}
                                            style={{
                                                '--timeline-group-width': groupWidth,
                                                '--timeline-x': `${group.x}rem`,
                                            }}
                                        >
                                            {above.length > 0 && (
                                                <>
                                                    <div className="photo-stats-timeline-row is-above">
                                                        {above.map(({ album, index, position }) => (
                                                            <TimelineCard key={album.albumId} album={album} index={index} position={position} />
                                                        ))}
                                                    </div>
                                                    <span className="photo-stats-timeline-branch is-above" aria-hidden="true" />
                                                </>
                                            )}
                                            {below.length > 0 && (
                                                <>
                                                    <div className="photo-stats-timeline-row is-below">
                                                        {below.map(({ album, index, position }) => (
                                                            <TimelineCard key={album.albumId} album={album} index={index} position={position} />
                                                        ))}
                                                    </div>
                                                    <span className="photo-stats-timeline-branch is-below" aria-hidden="true" />
                                                </>
                                            )}
                                            <span className="photo-stats-timeline-node">
                                                <span aria-hidden="true" />
                                                <time dateTime={group.createdAt || undefined}>{group.label}</time>
                                            </span>
                                        </li>
                                    )
                                })}
                            </ol>
                        </div>
                    </div>
                </div>
            )}
        </section>
    )
}

export default function Stats() {
    const [report, setReport] = useState(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [timelineAlbums, setTimelineAlbums] = useState([])
    const [timelineLoading, setTimelineLoading] = useState(true)
    const [timelineError, setTimelineError] = useState('')
    const [requestVersion, setRequestVersion] = useState(0)

    useEffect(() => {
        const controller = new AbortController()
        fetchPhotographyStats({ signal: controller.signal })
            .then(setReport)
            .catch((requestError) => {
                if (requestError?.name !== 'AbortError') {
                    setError(requestError?.message || 'The archive statistics could not be loaded.')
                }
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false)
            })
        fetchAlbums({ signal: controller.signal })
            .then(setTimelineAlbums)
            .catch((requestError) => {
                if (requestError?.name !== 'AbortError') {
                    setTimelineError(requestError?.message || 'The album timeline could not be loaded.')
                }
            })
            .finally(() => {
                if (!controller.signal.aborted) setTimelineLoading(false)
            })
        return () => controller.abort()
    }, [requestVersion])

    const categoryMaximum = useMemo(() => Math.max(
        1,
        ...(report?.categories || []).map((category) => Number(category.photos || 0) + Number(category.videos || 0)),
    ), [report])

    return (
        <div className="photo-stats-page">
            <header className="photo-stats-hero">
                <div className="photo-stats-title-row">
                    <h1>Photography <em>Stats</em></h1>
                </div>
            </header>

            {loading && (
                <div className="photo-stats-loading" role="status" aria-label="Loading photography statistics" aria-live="polite">
                    <span className="photo-stats-spinner" aria-hidden="true" />
                    <p>Developing the numbers…</p>
                </div>
            )}

            {!loading && error && (
                <div className="photo-stats-error" role="alert">
                    <p>The archive statistics could not be loaded.</p>
                    <p>{error}</p>
                    <button
                        type="button"
                        onClick={() => {
                            setError('')
                            setLoading(true)
                            setRequestVersion((version) => version + 1)
                        }}
                    >
                        Try again
                    </button>
                </div>
            )}

            {!loading && !error && report && (
                <div className="photo-stats-content">
                    <AlbumTimeline
                        albums={timelineAlbums}
                        loading={timelineLoading}
                        error={timelineError}
                        onRetry={() => {
                            setTimelineError('')
                            setTimelineLoading(true)
                            setRequestVersion((version) => version + 1)
                        }}
                    />

                    <section className="photo-stats-motion-section" aria-labelledby="stats-at-a-glance">
                        <SectionHeading id="stats-at-a-glance" index={1} eyebrow="At a glance" title="Capture Stats" detail={`Updated ${dateLabel(report.generatedAt)}`} />
                        <div className="photo-stats-card-grid">
                            <StatCard index={1} label="Photos taken" value={number(report.taken?.photos)} />
                            <StatCard index={2} label="Videos taken" value={number(report.taken?.videos)} />
                            <StatCard index={3} label="Photos edited / published" value={number(report.kept?.photos)} />
                            <StatCard index={4} label="Videos edited / published" value={number(report.kept?.videos)} />
                        </div>
                        <div className="photo-stats-kept-grid">
                            <KeptMeter label="Photos kept" kept={report.kept?.photos} taken={report.taken?.photos} percent={report.kept?.photoPercent} />
                            <KeptMeter label="Videos kept" kept={report.kept?.videos} taken={report.taken?.videos} percent={report.kept?.videoPercent} />
                        </div>
                    </section>

                    <section className="photo-stats-motion-section" aria-labelledby="archive-scale-heading">
                        <SectionHeading id="archive-scale-heading" index={2} eyebrow="The collection" title="Total Storage Used" />
                        <div className="photo-stats-scale-grid">
                            <article className="photo-stats-storage-card">
                                <p className="photo-stats-eyebrow">Total space taken</p>
                                <p className="photo-stats-storage-value">{formatBytes(report.storage?.totalBytes)}</p>
                            </article>
                            <StatCard index={5} label="Photo albums" value={number(report.albums?.photos)} />
                            <StatCard index={6} label="Video albums" value={number(report.albums?.videos)} />
                        </div>
                    </section>

                    <section className="photo-stats-motion-section" aria-labelledby="output-heading">
                        <SectionHeading id="output-heading" index={3} eyebrow="Timeline" title="Output by year" detail="Public work only" />
                        <div className="photo-stats-table-wrap">
                            <table className="photo-stats-table">
                                <thead>
                                    <tr>
                                        <th scope="col">Year</th>
                                        <th scope="col">Photo albums</th>
                                        <th scope="col">Photos</th>
                                        <th scope="col">Video albums</th>
                                        <th scope="col">Videos</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {(report.outputByYear || []).map((year) => (
                                        <tr key={year.year}>
                                            <th scope="row">{year.year}</th>
                                            <td>{number(year.photoAlbums)}</td>
                                            <td>{number(year.photos)}</td>
                                            <td>{number(year.videoAlbums)}</td>
                                            <td>{number(year.videos)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        <div className="photo-stats-highlights">
                            <article>
                                <p className="photo-stats-eyebrow">Most active year</p>
                                <strong>{report.mostActive?.year?.year || '—'}</strong>
                                <span>{number(report.mostActive?.year?.photos)} photos · {number(report.mostActive?.year?.videos)} videos</span>
                            </article>
                            <article>
                                <p className="photo-stats-eyebrow">Most active category</p>
                                <strong>{report.mostActive?.category?.category || '—'}</strong>
                                <span>{number(report.mostActive?.category?.albums)} albums</span>
                            </article>
                        </div>
                    </section>

                    <section className="photo-stats-motion-section" aria-labelledby="categories-heading">
                        <SectionHeading id="categories-heading" index={4} eyebrow="Subjects" title="Category distribution" detail="Ranked by work kept" />
                        <ol className="photo-stats-categories">
                            {(report.categories || []).map((category, index) => {
                                const mediaCount = Number(category.photos || 0) + Number(category.videos || 0)
                                return (
                                    <li key={category.category}>
                                        <div className="photo-stats-category-copy">
                                            <span className="photo-stats-category-rank">{String(index + 1).padStart(2, '0')}</span>
                                            <strong>{category.category}</strong>
                                            <span>{number(category.albums)} albums · {number(category.photos)} photos · {number(category.videos)} videos</span>
                                        </div>
                                        <div className="photo-stats-category-track" aria-hidden="true">
                                            <span style={{ width: `${Math.max(1, (mediaCount / categoryMaximum) * 100)}%` }} />
                                        </div>
                                    </li>
                                )
                            })}
                        </ol>
                    </section>

                    <section className="photo-stats-motion-section" aria-labelledby="gear-heading">
                        <SectionHeading id="gear-heading" index={5} eyebrow="Tools of the trade" title="Gear" detail="Based on published-photo EXIF" />
                        <div className="photo-stats-gear-grid">
                            <GearList title="Cameras" items={report.gear?.cameras || []} />
                            <GearList title="Lenses" items={report.gear?.lenses || []} />
                        </div>
                    </section>
                </div>
            )}
        </div>
    )
}
