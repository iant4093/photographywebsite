import './print.css'

const STORE_ID = import.meta.env.VITE_FOTOMOTO_STORE_ID || 'f3b4ffed02e8ae181e8de27d1b75195593fbcd49'
const CANONICAL_PRINT_HOST = 'prints.iantruongphotography.com'
const WIDGET_URL = `https://widget.fotomoto.com/stores/script/${STORE_ID}.js?api=true`
const STORE_URL = `https://my.fotomoto.com/store/${STORE_ID}`
const title = document.getElementById('print-title')
const status = document.getElementById('print-status')
const reopen = document.getElementById('print-reopen')
const fallback = document.getElementById('print-fallback')

let printApi = null
let stagedImageUrl = ''

window.opener = null

function setError(message) {
    title.textContent = 'Print store unavailable'
    status.textContent = message
    reopen.hidden = true
    fallback.hidden = false
}

function showPrintOptions() {
    if (!printApi || !stagedImageUrl) return
    printApi.showWindow(printApi.PRINT, stagedImageUrl)
}

function sessionFromFragment() {
    const parameters = new URLSearchParams(window.location.hash.slice(1))
    const token = parameters.get('session') || ''
    window.history.replaceState(null, '', '/print.html')
    return token
}

function loadFotomoto() {
    return new Promise((resolve, reject) => {
        let settled = false
        let timeout = null
        const finish = (callback, value) => {
            if (settled) return
            settled = true
            if (timeout !== null) window.clearTimeout(timeout)
            callback(value)
        }
        window.fotomoto_loaded = () => {
            const api = window.FOTOMOTO?.API
            if (api) finish(resolve, api)
            else finish(reject, new Error('The print store did not initialize.'))
        }
        const script = document.createElement('script')
        script.src = WIDGET_URL
        script.async = true
        script.referrerPolicy = 'no-referrer'
        script.onerror = () => finish(reject, new Error('The print store could not be loaded.'))
        document.head.append(script)
        timeout = window.setTimeout(
            () => finish(reject, new Error('The print store took too long to load.')),
            15_000,
        )
    })
}

async function start() {
    if (
        window.location.protocol === 'https:'
        && window.location.hostname !== CANONICAL_PRINT_HOST
        && !['localhost', '127.0.0.1'].includes(window.location.hostname)
    ) {
        window.location.replace(`https://${CANONICAL_PRINT_HOST}/print.html${window.location.hash}`)
        return
    }
    // Keep the vendor script on a storage-clean origin even if somebody
    // previously opened the application through the print hostname. Run this
    // only after the host guard so /print.html on the primary site can never
    // clear the authenticated application's storage.
    try { window.localStorage.clear() } catch { /* storage may be unavailable */ }
    try { window.sessionStorage.clear() } catch { /* storage may be unavailable */ }
    const sessionToken = sessionFromFragment()
    if (!sessionToken || sessionToken.length > 2048) {
        setError('Return to a photograph and choose “Order a Print” again.')
        return
    }
    try {
        const response = await fetch('/api/print/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionToken }),
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
        })
        if (!response.ok) throw new Error('This private print session expired or could not be prepared.')
        const payload = await response.json()
        if (typeof payload?.imageUrl !== 'string' || !payload.imageUrl.startsWith('https://')) {
            throw new Error('The photograph was not prepared correctly.')
        }
        const source = document.createElement('img')
        source.src = payload.imageUrl
        source.alt = ''
        source.hidden = true
        source.referrerPolicy = 'no-referrer'
        document.body.append(source)

        title.textContent = 'Opening print options'
        status.textContent = 'Fotomoto is loading print, size, payment, and shipping choices…'
        printApi = await loadFotomoto()
        stagedImageUrl = payload.imageUrl
        title.textContent = 'Print options ready'
        status.textContent = 'If you close the Fotomoto panel, you can reopen it here without leaving your photograph.'
        reopen.hidden = false
        showPrintOptions()
    } catch (error) {
        setError(error?.message || 'Return to the photograph and try again.')
    }
}

reopen.addEventListener('click', showPrintOptions)
fallback.href = STORE_URL

start()
