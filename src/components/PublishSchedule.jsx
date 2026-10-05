import { useId, useState } from 'react'
import { PUBLISH_CHECK_MINUTES, localDateTimeValue, timeZoneName } from '../utils/publishSchedule'

const choiceClass = (active, first) => `admin-upload-choice flex-1 py-3 px-2 text-sm font-medium transition-all duration-200 cursor-pointer ${first ? '' : 'border-l border-warm-border '}${active
    ? 'bg-amber text-white'
    : 'bg-cream text-warm-gray hover:bg-cream-dark'
}`

// "Right away" or "Schedule for later" for a main-gallery upload.
export default function PublishSchedule({ scheduled, value, onScheduledChange, onValueChange, disabled = false }) {
    const id = useId()
    const [minimum] = useState(() => localDateTimeValue(new Date()))
    const zone = timeZoneName()
    return (
        <div className="mb-6">
            <span id={`${id}-label`} className="block text-sm font-medium text-charcoal mb-3">Publish</span>
            <div role="group" aria-labelledby={`${id}-label`} className="flex rounded-xl overflow-hidden border border-warm-border">
                <button type="button" aria-pressed={!scheduled} disabled={disabled} onClick={() => onScheduledChange(false)} className={choiceClass(!scheduled, true)}>
                    Right away
                </button>
                <button type="button" aria-pressed={scheduled} disabled={disabled} onClick={() => onScheduledChange(true)} className={choiceClass(scheduled, false)}>
                    Schedule for later
                </button>
            </div>
            {scheduled && (
                <div className="mt-4 animate-fade-in">
                    <label htmlFor={`${id}-time`} className="block text-sm font-medium text-charcoal mb-2">Publish on</label>
                    <input
                        id={`${id}-time`}
                        type="datetime-local"
                        value={value}
                        min={minimum}
                        step={PUBLISH_CHECK_MINUTES * 60}
                        required
                        disabled={disabled}
                        onChange={(event) => onValueChange(event.target.value)}
                        className="w-full px-4 py-3 rounded-xl border border-warm-border bg-cream/50 text-charcoal focus:outline-none focus:ring-2 focus:ring-amber/40 focus:border-amber transition-all duration-200"
                    />
                    <p className="mt-2 text-xs text-warm-gray">
                        The album stays hidden until then and goes live within {PUBLISH_CHECK_MINUTES} minutes of this time{zone ? ` (${zone})` : ''}. You can change or cancel it in Manage Albums.
                    </p>
                </div>
            )}
        </div>
    )
}
