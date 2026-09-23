// A controllable XHR response adapter for API-level upload retry tests.
export function uploadXHR(respond) {
    return class {
        upload = {}
        headers = {}
        open(method, url) { this.method = method; this.url = url }
        setRequestHeader(name, value) { this.headers[name] = value }
        getAllResponseHeaders() { return [...this.response.headers].map(([name, value]) => `${name}: ${value}`).join('\r\n') }
        async send(body) {
            try {
                this.response = await respond(this.url, { method: this.method, headers: this.headers, body })
                this.status = this.response.status
                this.responseText = await this.response.text()
                this.onload()
            } catch (error) { if (error.name === 'AbortError') this.onabort(); else this.onerror() }
        }
        abort() { this.onabort() }
    }
}
