import { rememberVideoNavigation } from '../utils/lightboxNavigation'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { albumCoverUrl } from '../utils/mediaUrls'
import useAlbumIntent from '../hooks/useAlbumIntent'
import useNavigationState from '../hooks/useNavigationState'
import { buildYear, calendarDays, calendarYears, countLabel, formatDay } from '../utils/shootingCalendar'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['', 'Mon', '', 'Wed', '', 'Fri', '']

function CalendarAlbumTile({ album, href }) {
    const intent = useAlbumIntent(album)
    const cover = albumCoverUrl(album)
    return (
        <Link {...intent} data-route-card="calendar" to={href} onClick={event => rememberVideoNavigation(href, event, event.currentTarget.querySelector('img'))}>
            {cover ? <img src={cover} alt="" loading="lazy" decoding="async" /> : <span className="shooting-calendar-day-blank" />}
            <span>
                <strong>{album.title || 'Untitled album'}</strong>
                <small>{album.category || (album.type === 'video' ? 'Video' : 'Photos')}</small>
            </span>
        </Link>
    )
}

// A GitHub-style year of shooting days; picking a day lists what was shot.
export default function ShootingCalendar({ calendar, albums, routeFor, today }) {
    const days = useMemo(() => calendarDays(calendar), [calendar])
    const years = useMemo(() => calendarYears(days), [days])
    const [now] = useState(() => today || new Date())
    const [year, setYear] = useNavigationState('shooting-calendar-year', null)
    const [selected, setSelected] = useNavigationState('shooting-calendar-date', null)
    const scrollRef = useRef(null)
    const summaryRef = useRef(null)
    const yearChange = useRef(null)
    const dayRef = useRef(null)
    const previousDayHeight = useRef(null)
    const shownYear = years.includes(year) ? year : years[0]
    const grid = useMemo(() => (shownYear ? buildYear(days, shownYear, now) : null), [days, shownYear, now])
    const albumsById = useMemo(() => new Map((albums || []).map((album) => [album.albumId, album])), [albums])
    const publicationLabels = useMemo(() => {
        const counts = new Map()
        for (const { date, photos, videos } of days.values()) {
            const year = Number(date.slice(0, 4))
            const totals = counts.get(year) || { photos: 0, videos: 0 }
            totals.photos += photos
            totals.videos += videos
            counts.set(year, totals)
        }
        return [...counts].map(([year, { photos, videos }]) => [year, countLabel(photos, videos)])
    }, [days])

    // Open on the most recent weeks; on a phone the year scrolls sideways.
    useLayoutEffect(() => {
        const element = scrollRef.current
        if (!element) return undefined
        element.scrollLeft = element.scrollWidth
        if (yearChange.current !== shownYear) return undefined
        yearChange.current = null
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !element.animate) return undefined
        const targets = [...summaryRef.current.querySelectorAll('dd'), element.firstElementChild]
        const animations = targets.map(target => target.animate([{ opacity: .18 }, { opacity: 1 }], {
            duration: 320, easing: 'ease-in-out',
        }))
        return () => animations.forEach(animation => animation.cancel())
    }, [shownYear])

    useLayoutEffect(() => {
        const panel = dayRef.current
        const fromHeight = previousDayHeight.current
        previousDayHeight.current = null
        if (fromHeight === null || !panel?.animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined

        const toHeight = panel.offsetHeight
        const reveal = panel.firstElementChild.animate([{ opacity: .12 }, { opacity: 1 }], {
            duration: 300, easing: 'ease-out',
        })
        const resize = fromHeight !== toHeight ? panel.animate([
            { height: `${fromHeight}px`, overflow: 'hidden' },
            { height: `${toHeight}px`, overflow: 'hidden' },
        ], { duration: 320, easing: 'ease-in-out' }) : null
        return () => {
            reveal.cancel()
            resize?.cancel()
        }
    }, [selected])

    const selectDay = date => {
        if (date === selected) return
        previousDayHeight.current = dayRef.current?.offsetHeight ?? null
        setSelected(date)
    }
    if (!grid) return null
    const selectedDay = selected && days.get(selected)
    const selectedAlbums = selectedDay ? selectedDay.albumIds.map((id) => albumsById.get(id)).filter(Boolean) : []
    const { summary } = grid

    return (
        <div className="shooting-calendar">
            {years.length > 1 && (
                <div className="shooting-calendar-years" role="group" aria-label="Year">
                    {years.map((value) => (
                        <button key={value} type="button" aria-pressed={value === shownYear}
                            onClick={() => {
                                if (value !== shownYear) yearChange.current = value
                                setYear(value)
                                selectDay(null)
                            }}>
                            {value}
                        </button>
                    ))}
                </div>
            )}

            <dl className="shooting-calendar-summary" ref={summaryRef}>
                <div><dt>Days shooting</dt><dd>{summary.days}</dd></div>
                <div><dt>Longest streak</dt><dd>{summary.longestStreak} day{summary.longestStreak === 1 ? '' : 's'}</dd></div>
                <div>
                    <dt>Busiest day</dt>
                    <dd>{summary.busiest ? (
                        <button type="button" className="shooting-calendar-link" onClick={() => selectDay(summary.busiest.date)}>
                            {formatDay(summary.busiest.date, 'short')}
                        </button>
                    ) : '—'}</dd>
                </div>
                <div>
                    <dt>Published</dt>
                    <dd className="shooting-calendar-publications">
                        {publicationLabels.map(([value, label]) => (
                            <span key={value} aria-hidden={value === shownYear ? undefined : true}>{label}</span>
                        ))}
                    </dd>
                </div>
            </dl>

            <div className="shooting-calendar-scroll" ref={scrollRef}>
                <div className="shooting-calendar-grid" style={{ '--weeks': grid.weeks.length }}>
                    <div className="shooting-calendar-months" aria-hidden="true">
                        {grid.months.map(({ month, week }) => (
                            <span key={month} style={{ gridColumn: week + 1 }}>{MONTHS[month]}</span>
                        ))}
                    </div>
                    <div className="shooting-calendar-weekdays" aria-hidden="true">
                        {WEEKDAYS.map((label, index) => <span key={index}>{label}</span>)}
                    </div>
                    <div className="shooting-calendar-cells" role="group" aria-label={`Shooting days in ${shownYear}`}>
                        {grid.weeks.flatMap((week, weekIndex) => week.map((cell, dayIndex) => {
                            const key = cell?.date || `blank-${weekIndex}-${dayIndex}`
                            if (!cell || !cell.total) {
                                return <span key={key} className={`shooting-calendar-cell${cell ? '' : ' is-outside'}${cell?.future ? ' is-future' : ''}`} aria-hidden="true" />
                            }
                            const label = `${formatDay(cell.date)}: ${countLabel(cell.day.photos, cell.day.videos)}`
                            return (
                                <button key={key} type="button" className={`shooting-calendar-cell level-${cell.level}`}
                                    aria-label={label} title={label} aria-pressed={selected === cell.date}
                                    onClick={() => selectDay(selected === cell.date ? null : cell.date)} />
                            )
                        }))}
                    </div>
                </div>
            </div>

            <div className="shooting-calendar-legend" aria-hidden="true">
                <span>Less</span>
                {[0, 1, 2, 3, 4].map((level) => <span key={level} className={`shooting-calendar-cell level-${level}`} />)}
                <span>More</span>
            </div>

            <div className="shooting-calendar-day" ref={dayRef} aria-live="polite">
                <div>
                    {selectedDay ? (
                        <>
                            <div className="shooting-calendar-day-heading">
                                <h3>{formatDay(selectedDay.date)}</h3>
                                <p>{countLabel(selectedDay.photos, selectedDay.videos)}</p>
                            </div>
                            {selectedAlbums.length ? (
                                <ul>
                                    {selectedAlbums.map((album) => (
                                        <li key={album.albumId}>
                                            <CalendarAlbumTile album={album} href={routeFor(album)} />
                                        </li>
                                    ))}
                                </ul>
                            ) : (
                                <p className="shooting-calendar-hint">These albums are no longer public.</p>
                            )}
                        </>
                    ) : (
                        <p className="shooting-calendar-hint">Pick a day to see what was shot.</p>
                    )}
                </div>
            </div>
        </div>
    )
}
