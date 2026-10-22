import { Link } from 'react-router'
import { UTILITY_MODULES } from '../utils/utilityModules'
import './Explore.css'
import './Utilities.css'

function UtilityArt({ id }) {
    return (
        <div className={`utility-module-art utility-module-art--${id}`} aria-hidden="true">
            {id === 'web-editor' ? (
                <svg viewBox="0 0 240 160" fill="none" stroke="currentColor">
                    <rect x="24" y="20" width="192" height="120" rx="2" />
                    <path d="M24 40h192M166 40v100M36 30h3m7 0h3m7 0h3" />
                    <rect x="38" y="54" width="114" height="72" />
                    <circle cx="120" cy="74" r="9" />
                    <path d="m38 111 32-33 26 27 17-15 39 36M178 62h26m-26 22h26m-26 22h26" />
                    <circle cx="187" cy="62" r="3" /><circle cx="198" cy="84" r="3" /><circle cx="184" cy="106" r="3" />
                </svg>
            ) : id === 'truongroom' ? (
                <svg viewBox="0 0 240 160" fill="none" stroke="currentColor">
                    <path d="M35 132V28h170v104H35Zm0-104 32 25h106l32-25M67 53v55h106V53M35 132l32-24m106 0 32 24" />
                    <rect x="85" y="66" width="70" height="28" /><path d="m85 94 21-19 17 14 13-10 19 15" />
                </svg>
            ) : id === 'truongnoiser' ? (
                <svg viewBox="0 0 240 160" fill="none" stroke="currentColor">
                    <rect x="32" y="28" width="176" height="104" rx="2" />
                    <path d="M120 28v104m-78-18 26-27 22 14 20-22m20 35 26-27 22 14 20-22M45 46h2m12 11h2m18-12h2m18 19h2M48 77h2m45 38h2m-28 9h2" />
                    <circle cx="166" cy="58" r="10" />
                </svg>
            ) : id === 'truongscaler' ? (
                <svg viewBox="0 0 240 160" fill="none" stroke="currentColor">
                    <rect x="32" y="76" width="70" height="56" rx="2" />
                    <path d="m32 121 21-21 17 14 13-10 19 17M124 28h84v84m-84 0 84-84M167 28h41v41" />
                    <circle cx="81" cy="91" r="6" />
                </svg>
            ) : (
                <svg viewBox="0 0 240 160" fill="none" stroke="currentColor">
                    <path d="M34 53h42l12-19h64l12 19h42v79H34V53Z" />
                    <circle cx="120" cy="91" r="32" /><circle cx="120" cy="91" r="22" />
                    <path d="M48 66h20m110 0h14M93 24h54" />
                </svg>
            )}
        </div>
    )
}

export function UtilityComingSoon({ moduleId }) {
    const module = UTILITY_MODULES.find(candidate => candidate.id === moduleId)
    return (
        <div className="explore-page utilities-page animate-fade-in pt-[74px]">
            <section className="utility-coming-soon max-w-7xl mx-auto px-6 py-20 md:py-28" aria-labelledby="utility-title">
                <Link to="/utilities" className="explore-back">← All Utilities modules</Link>
                <div className="utility-coming-soon-content">
                    <UtilityArt id={module.id} />
                    <span className="utility-status">Coming soon</span>
                    <h1 id="utility-title" className="font-serif text-4xl md:text-6xl text-charcoal">{module.title}</h1>
                    <p>{module.detail}</p>
                    <Link to="/editor" className="utility-editor-link">Try Web Editor →</Link>
                </div>
            </section>
        </div>
    )
}

export default function Utilities() {
    return (
        <div className="explore-page utilities-page animate-fade-in pt-[74px]">
            <header className="explore-header max-w-7xl mx-auto px-6 pt-14 pb-8 md:pt-20 md:pb-12">
                <div className="linen-section-heading editorial-motion-frame">
                    <span>Photography tools</span>
                    <h1 className="font-serif text-4xl md:text-6xl font-normal text-charcoal">Utilities</h1>
                    <p>Photo apps and browser tools.</p>
                </div>
            </header>
            <section className="explore-modules utility-modules max-w-7xl mx-auto px-6 pb-20 md:pb-28" aria-label="Utilities modules">
                {UTILITY_MODULES.map((module, index) => (
                    <Link key={module.id} to={module.path} className="explore-module-card editorial-motion-media">
                        <span className="explore-module-number">{String(index + 1).padStart(2, '0')}</span>
                        <UtilityArt id={module.id} />
                        <div>
                            <span className="utility-status">{module.comingSoon ? 'Coming soon' : 'Available now'}</span>
                            <h2>{module.title}</h2>
                            <p>{module.detail}</p>
                        </div>
                        <span className="explore-module-arrow" aria-hidden="true">→</span>
                    </Link>
                ))}
            </section>
        </div>
    )
}
