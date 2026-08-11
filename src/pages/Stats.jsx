import { useEffect, useMemo, useState } from 'react'
import { fetchPhotographyStats } from '../utils/api'
import { formatBytes } from '../utils/formatBytes'
import './Stats.css'


const numberFormatter = new Intl.NumberFormat('en-US')

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

function StatCard({ index, label, value, note }) {
    return (
        <article className="photo-stats-card">
            <span className="photo-stats-card-index" aria-hidden="true">{String(index).padStart(2, '0')}</span>
            <p className="photo-stats-eyebrow">{label}</p>
            <p className="photo-stats-value">{value}</p>
            <p className="photo-stats-note">{note}</p>
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

export default function Stats() {
    const [report, setReport] = useState(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
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
        return () => controller.abort()
    }, [requestVersion])

    const categoryMaximum = useMemo(() => Math.max(
        1,
        ...(report?.categories || []).map((category) => Number(category.photos || 0) + Number(category.videos || 0)),
    ), [report])

    return (
        <div className="photo-stats-page">
            <header className="photo-stats-hero">
                <p className="photo-stats-kicker">Field notes · The numbers behind the photographs</p>
                <div className="photo-stats-title-row">
                    <h1>The Archive,<br /><em>by the numbers.</em></h1>
                    <p>
                        A living record of photographs made, films captured, work kept,
                        and the tools that shaped it.
                    </p>
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
                    <section aria-labelledby="stats-at-a-glance">
                        <SectionHeading id="stats-at-a-glance" index={1} eyebrow="At a glance" title="From shutter to screen" detail={`Updated ${dateLabel(report.generatedAt)}`} />
                        <div className="photo-stats-card-grid">
                            <StatCard index={1} label="Photos taken" value={number(report.taken?.photos)} note="Image files in the raw archive" />
                            <StatCard index={2} label="Videos taken" value={number(report.taken?.videos)} note="Video files in the raw archive" />
                            <StatCard index={3} label="Photos edited / published" value={number(report.kept?.photos)} note="Public photographs on this website" />
                            <StatCard index={4} label="Videos edited / published" value={number(report.kept?.videos)} note="Public videos on this website" />
                        </div>
                        <div className="photo-stats-kept-grid">
                            <KeptMeter label="Photos kept" kept={report.kept?.photos} taken={report.taken?.photos} percent={report.kept?.photoPercent} />
                            <KeptMeter label="Videos kept" kept={report.kept?.videos} taken={report.taken?.videos} percent={report.kept?.videoPercent} />
                        </div>
                    </section>

                    <section aria-labelledby="archive-scale-heading">
                        <SectionHeading id="archive-scale-heading" index={2} eyebrow="The collection" title="The scale of the archive" />
                        <div className="photo-stats-scale-grid">
                            <article className="photo-stats-storage-card">
                                <p className="photo-stats-eyebrow">Total space taken</p>
                                <p className="photo-stats-storage-value">{formatBytes(report.storage?.totalBytes)}</p>
                                <p>All photo and video files across the raw archive and website backup, including both original and edited copies.</p>
                            </article>
                            <StatCard index={5} label="Photo albums" value={number(report.albums?.photos)} note="Public photographic series" />
                            <StatCard index={6} label="Video albums" value={number(report.albums?.videos)} note="Public moving-image collections" />
                        </div>
                    </section>

                    <section aria-labelledby="output-heading">
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

                    <section aria-labelledby="categories-heading">
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

                    <section aria-labelledby="gear-heading">
                        <SectionHeading id="gear-heading" index={5} eyebrow="Tools of the trade" title="Gear represented in the archive" detail="Based on published-photo EXIF" />
                        <div className="photo-stats-gear-grid">
                            <GearList title="Cameras" items={report.gear?.cameras || []} />
                            <GearList title="Lenses" items={report.gear?.lenses || []} />
                        </div>
                        <p className="photo-stats-methodology">
                            Photos without lens metadata are attributed to the {report.gear?.manualLensFallback || 'manual lens'}.
                            “Taken” counts files in Raw Photo Backup; “edited / published” and “kept” count public website media.
                            Total storage combines photo and video bytes in Raw Photo Backup and Website Backup, so retained copies are intentionally included.
                        </p>
                    </section>
                </div>
            )}
        </div>
    )
}
