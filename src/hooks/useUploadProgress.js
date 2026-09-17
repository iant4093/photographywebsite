import { useEffect, useRef, useState } from 'react'
import { createUploadProgress } from '../utils/uploadProgress'

export function useUploadProgress() {
    const [progress, setProgress] = useState(null)
    const active = useRef(null)

    useEffect(() => () => active.current?.stop(), [])

    function startUpload(files) {
        active.current?.stop()
        const tracker = createUploadProgress(files)
        let stopped = false
        const publish = () => { if (!stopped) setProgress(tracker.snapshot()) }
        // Sampling continues during stalls, so an old fast rate cannot leave a
        // misleading countdown frozen on screen. React updates at most 2x/sec
        // between file completions, even with concurrent upload events.
        const timer = window.setInterval(publish, 500)
        const session = {
            progressFor: tracker.progressFor,
            restorePart: tracker.restorePart,
            completeFile() { tracker.completeFile(); publish() },
            finalize() { tracker.finalize(); window.clearInterval(timer); publish() },
            stop() { stopped = true; window.clearInterval(timer) },
        }
        active.current = session
        publish()
        return session
    }

    return { progress, startUpload }
}
