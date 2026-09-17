import { formatUploadBytes, formatUploadTime } from '../utils/uploadProgress'

export default function UploadProgress({ progress }) {
    if (!progress) return null
    const { phase, loadedBytes, totalBytes, bytesPerSecond, remainingSeconds, completedFiles, totalFiles } = progress
    const saving = phase === 'saving'
    const transferred = loadedBytes >= totalBytes && totalBytes > 0
    const percent = saving ? 100 : Math.min(99, totalBytes > 0 ? Math.floor(loadedBytes / totalBytes * 100) : 0)
    const status = saving ? 'Saving album…'
        : transferred ? 'Finishing uploads…'
            : 'Uploading…'
    return (
        <div className="my-4 text-sm text-warm-gray">
            <div className="flex flex-wrap justify-between gap-2 mb-2">
                <span role="status">{status}</span>
                <span className="tabular-nums">{completedFiles} / {totalFiles} files</span>
            </div>
            <div role="progressbar" aria-label="File upload progress" aria-valuemin={0} aria-valuemax={100}
                aria-valuenow={percent} aria-valuetext={saving ? 'Files uploaded. Saving album.' : `${percent}% uploaded`}
                className="w-full h-2 bg-cream-dark rounded-full overflow-hidden">
                <div className="h-full bg-gradient-to-r from-amber to-amber-dark rounded-full transition-all duration-500"
                    style={{ width: `${percent}%` }} />
            </div>
            {saving ? (
                <p className="mt-2 text-xs">Files uploaded. Waiting for album confirmation.</p>
            ) : (
                <>
                    <dl className="mt-3 grid grid-cols-2 gap-3 tabular-nums">
                        <div><dt className="text-xs">Upload speed</dt>
                            <dd className="mt-1 font-medium text-charcoal">{bytesPerSecond === null ? 'Measuring…' : `${formatUploadBytes(bytesPerSecond)}/s`}</dd></div>
                        <div><dt className="text-xs">Estimated upload time left</dt>
                            <dd className="mt-1 font-medium text-charcoal">{transferred ? 'Confirming transfer…' : remainingSeconds !== null ? `About ${formatUploadTime(remainingSeconds)}`
                                : bytesPerSecond === 0 ? 'Waiting for transfer…' : 'Calculating…'}</dd></div>
                    </dl>
                    <p className="mt-2 text-xs tabular-nums">{formatUploadBytes(loadedBytes)} of {formatUploadBytes(totalBytes)} · Album saving follows upload.</p>
                </>
            )}
        </div>
    )
}
