import { Link } from 'react-router'
import './LegalPage.css'

export const LEGAL_UPDATED = 'September 17, 2026'
export const SUPPORT_EMAIL = 'iant4093@gmail.com'

export function SupportEmail({ subject = '', children }) {
    return <a href={`mailto:${SUPPORT_EMAIL}${subject ? `?subject=${encodeURIComponent(subject)}` : ''}`}>{children || SUPPORT_EMAIL}</a>
}

export default function LegalPage({ title, children }) {
    return (
        <article className="legal-page max-w-3xl mx-auto px-6 py-16 pt-[104px] md:pt-[120px] text-charcoal-light">
            <h1 className="font-serif text-4xl md:text-5xl font-semibold text-charcoal mb-6">{title}</h1>
            <p className="text-sm text-warm-gray mb-8">Last updated {LEGAL_UPDATED}</p>
            <div className="legal-copy">{children}</div>
            <nav className="legal-page-nav" aria-label="Policies and support">
                <Link to="/privacy">Privacy</Link>
                <Link to="/terms">Terms & photo use</Link>
                <Link to="/print-policy">Print orders & returns</Link>
                <Link to="/accessibility">Accessibility</Link>
                <Link to="/licenses">Software licenses</Link>
                <Link to="/contact">Contact</Link>
            </nav>
        </article>
    )
}
