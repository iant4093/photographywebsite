import { Component } from 'react'

export default class RecoveryBoundary extends Component {
    state = { failed: false }
    static getDerivedStateFromError() { return { failed: true } }
    render() {
        if (!this.state.failed) return this.props.children
        if (this.props.optional) return null
        return <div role="alert" className="max-w-xl mx-auto px-6 py-32">
            <h1 className="font-serif text-3xl">This page could not be opened</h1>
            <p className="my-4">Check your connection and try again. Reloading ends any work still open on this page.</p>
            <button className="underline mr-6" onClick={() => window.location.reload()}>Reload page</button>
            <a className="underline" href="/">Go to home</a>
        </div>
    }
}
