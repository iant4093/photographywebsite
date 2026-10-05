import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { albumCoverUrl } from '../utils/mediaUrls'
import { buildYear, calendarDays, calendarYears, countLabel, formatDay } from '../utils/shootingCalendar'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['', 'Mon', '', 'Wed', '', 'Fri', '']

// A GitHub-style year of shooting days; picking a day lists what was shot.
export default function ShootingCalendar({ calendar, albums, routeFor, today }) {
    const days = useMemo(() => calendarDays(calendar), [calendar])
    const years = useMemo(() => calendarYears(days), [days])
    const [now] = useState(() => today || new Date())
    const [year, setYear] = useState(null)
    const [selected, setSelected] = useState(null)
    const scrollRef = useRef(null)
    const shownYear = years.includes(year) ? year : years[0]
    const grid = useMemo(() => (shownYear ? buildYear(days, shownYear, now) : null), [days, shownYear, now])
    const albumsById = useMemo(() => new Map((albums || []).map((album) => [album.albumId, album])), [albums])

    // Open on the most recent weeks; on a phone the year scrolls sideways.
    useEffect(() => {
        const element = scrollRef.current
        if (element) element.scrollLeft = element.scrollWidth
    }, [shownYear])

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
                            onClick={() => { setYear(value); setSelected(null) }}>
                            {value}
                        </button>
                    ))}
                </div>
            )}

            <dl className="shooting-calendar-summary">
                <div><dt>Days shooting</dt><dd>{summary.days}</dd></div>
                <div><dt>Longest streak</dt><dd>{summary.longestStreak} day{summary.longestStreak === 1 ? '' : 's'}</dd></div>
                <div>
                    <dt>Busiest day</dt>
                    <dd>{summary.busiest ? (
                        <button type="button" className="shooting-calendar-link" onClick={() => setSelected(summary.busiest.date)}>
                            {formatDay(summary.busiest.date, 'short')}
                        </button>
                    ) : '—'}</dd>
                </div>
                <div><dt>Published</dt><dd>{countLabel(summary.photos, summary.videos)}</dd></div>
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
                                    onClick={() => setSelected(selected === cell.date ? null : cell.date)} />
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

            <div className="shooting-calendar-day" aria-live="polite">
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
                                        <Link to={routeFor(album)}>
                                            {albumCoverUrl(album) ? <img src={albumCoverUrl(album)} alt="" loading="lazy" decoding="async" /> : <span className="shooting-calendar-day-blank" />}
                                            <span>
                                                <strong>{album.title || 'Untitled album'}</strong>
                                                <small>{album.category || (album.type === 'video' ? 'Video' : 'Photos')}</small>
                                            </span>
                                        </Link>
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
    )
}
