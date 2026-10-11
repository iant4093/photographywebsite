import { Link } from 'react-router'
import './LegalPage.css'
import './Footer.css'

const POLICIES = [
    ['Privacy', '/privacy'],
    ['Terms & photo use', '/terms'],
    ['Prints & returns', '/print-policy'],
    ['Accessibility', '/accessibility'],
    ['Licenses', '/licenses'],
]

function PolicyLinks() {
    return (
        <nav className="linen-footer-links linen-closing-policies legal-footer-links" aria-label="Policies">
            {POLICIES.map(([label, path]) => <Link key={path} to={path}>{label}</Link>)}
        </nav>
    )
}

function ContactLinks() {
    return (
        <nav className="linen-closing-contact" aria-label="Contact and social links">
            <Link to="/contact">
                <svg fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
                    <rect x="3" y="5" width="18" height="14" rx="1.5" />
                    <path d="m3 6 9 7 9-7" />
                </svg>
                Contact me
            </Link>
            <a href="https://www.instagram.com/iant4093/" target="_blank" rel="noopener noreferrer">
                <svg fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path fillRule="evenodd" clipRule="evenodd" d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.88z" />
                </svg>
                Instagram
            </a>
            <a href="https://github.com/iant4093/photographywebsite" target="_blank" rel="noopener noreferrer">
                <svg fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.161 22 16.416 22 12c0-5.523-4.477-10-10-10z" />
                </svg>
                Source Code
            </a>
        </nav>
    )
}

function Footer({ editorial = true }) {
    const year = new Date().getFullYear()

    return (
        <footer className={`linen-footer mt-auto border-t border-warm-border bg-cream-dark/50 ${editorial ? 'linen-closing-footer' : 'linen-compact-footer'}`}>
            <div className="linen-closing-inner">
                {editorial ? (
                    <>
                        <div className="linen-closing-top">
                            <button
                                type="button"
                                className="linen-closing-back"
                                onClick={() => window.scrollTo({
                                    top: 0,
                                    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
                                })}
                            >
                                Back to top <span aria-hidden="true">↑</span>
                            </button>
                        </div>
                        <div className="linen-footer-identity linen-closing-signature">
                            <span className="linen-closing-rule" aria-hidden="true" />
                            <p className="linen-footer-mark">Ian Truong</p>
                            <span className="linen-closing-rule" aria-hidden="true" />
                        </div>
                    </>
                ) : null}
                <div className="linen-closing-bottom">
                    <p className="linen-closing-copyright">
                        {editorial ? `© ${year} — Photography archive` : `© ${year} Ian Truong`}
                    </p>
                    <PolicyLinks />
                    <ContactLinks />
                </div>
            </div>
        </footer>
    )
}

export default Footer
