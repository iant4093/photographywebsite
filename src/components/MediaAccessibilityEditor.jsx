import { useId, useState } from 'react'

export default function MediaAccessibilityEditor({ image, isVideo, onSave, onClose }) {
    const prefix = useId()
    const [values, setValues] = useState({ altText: image.altText || '', captionVtt: image.captionVtt || '', captionLanguage: image.captionLanguage || 'en', transcript: image.transcript || '' })
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState('')
    const change = (field, value) => setValues(previous => ({ ...previous, [field]: value }))
    const save = async event => {
        event.preventDefault()
        setSaving(true)
        setError('')
        try {
            await onSave(isVideo ? values : { altText: values.altText })
            onClose()
        } catch (failure) { setError(failure.message || 'The description could not be saved.') }
        finally { setSaving(false) }
    }
    const importCaptions = async event => {
        const file = event.target.files?.[0]
        if (!file) return
        try {
            if (file.size > 24000) throw new Error('Use a caption file under 24 KB and 16,000 characters.')
            const text = await file.text()
            if (text.length > 16000) throw new Error('Captions must be at most 16,000 characters.')
            change('captionVtt', text)
            setError('')
        } catch (failure) { setError(failure.message) }
        event.target.value = ''
    }
    const fieldClass = 'block w-full mt-2 p-3 rounded-lg border border-warm-border bg-white text-charcoal'
    return <form onSubmit={save} className="mt-4 p-5 rounded-xl border border-warm-border bg-cream" aria-label="Edit media accessibility">
        <h3 className="font-serif text-xl text-charcoal">Descriptions & captions</h3>
        <p className="mt-2 text-sm text-warm-gray">Describe what is actually visible. Avoid names or sensitive details unless they are appropriate for this gallery’s audience. Saving makes this text available to everyone who can access this item.</p>
        <label htmlFor={`${prefix}-alt`} className="block mt-4 text-sm text-charcoal">{isVideo ? 'Short video description' : 'Photo description (alt text)'}</label>
        <textarea id={`${prefix}-alt`} value={values.altText} onChange={e => change('altText', e.target.value)} maxLength={500} rows={3} className={fieldClass} />
        {isVideo && <>
            <label htmlFor={`${prefix}-language`} className="block mt-4 text-sm text-charcoal">Caption language (for example, en or es)</label>
            <input id={`${prefix}-language`} value={values.captionLanguage} onChange={e => change('captionLanguage', e.target.value)} maxLength={35} pattern="[a-zA-Z]{2,8}(-[a-zA-Z0-9]{1,8})*" className={fieldClass} />
            <label htmlFor={`${prefix}-file`} className="block mt-4 text-sm text-charcoal">Import a WebVTT caption file</label>
            <input id={`${prefix}-file`} type="file" accept=".vtt,text/vtt" onChange={importCaptions} className={fieldClass} />
            <label htmlFor={`${prefix}-captions`} className="block mt-4 text-sm text-charcoal">Timed captions (WebVTT)</label>
            <textarea id={`${prefix}-captions`} value={values.captionVtt} onChange={e => change('captionVtt', e.target.value)} maxLength={16000} rows={7} spellCheck={false} className={`${fieldClass} font-mono text-sm`} />
            <p className="mt-2 text-sm text-warm-gray">Use accurate speech, speaker names where appropriate, and meaningful sounds. Include the WEBVTT header and timed cues. Leave empty to remove this caption track.</p>
            <label htmlFor={`${prefix}-transcript`} className="block mt-4 text-sm text-charcoal">Transcript & visual description</label>
            <textarea id={`${prefix}-transcript`} value={values.transcript} onChange={e => change('transcript', e.target.value)} maxLength={8000} rows={6} className={fieldClass} />
        </>}
        {error && <p role="alert" className="mt-3 text-red-700">{error}</p>}
        <div className="flex flex-wrap gap-3 mt-4">
            <button type="submit" disabled={saving} className="px-4 py-2 rounded-lg bg-charcoal text-white disabled:opacity-60">{saving ? 'Saving…' : 'Save accessibility text'}</button>
            <button type="button" disabled={saving} onClick={onClose} className="px-4 py-2 rounded-lg border border-warm-border text-charcoal">Cancel</button>
        </div>
    </form>
}
