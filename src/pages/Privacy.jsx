import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import {
    analyticsPreference,
    setAnalyticsPreference,
    subscribeToAnalyticsPreference,
} from '../utils/analytics'

export default function Privacy() {
    const [analytics, setAnalytics] = useState(analyticsPreference)

    useEffect(() => subscribeToAnalyticsPreference(() => setAnalytics(analyticsPreference())), [])

    const chooseAnalytics = (enabled) => {
        setAnalyticsPreference(enabled)
        setAnalytics(analyticsPreference())
    }

    return (
        <div className="max-w-3xl mx-auto px-6 py-16 pt-[104px] md:pt-[120px] animate-fade-in">
            <h1 className="font-serif text-4xl md:text-5xl font-semibold text-charcoal mb-6">Privacy Notice</h1>
            <p className="text-sm text-warm-gray mb-10">Last updated August 26, 2026</p>

            <div className="space-y-8 text-charcoal-light leading-relaxed">
                <section>
                    <h2 className="font-serif text-2xl font-semibold text-charcoal mb-3">Information this site uses</h2>
                    <p>
                        If you contact me, the site processes the name, email address, and message you submit so I can respond.
                        Client accounts use an email address for sign-in and access to assigned private galleries. Galleries may
                        contain photos, videos, dates, and camera metadata selected for delivery to a client. The browser stores
                        sign-in and appearance preferences locally so sessions and theme choices can persist.
                    </p>
                </section>

                <section>
                    <h2 className="font-serif text-2xl font-semibold text-charcoal mb-3">Aggregate website analytics</h2>
                    <p>
                        This site uses first-party, cookie-free analytics to count public page loads, album views, downloads,
                        contact-form completions, homepage exploration clicks, approximate traffic-source categories, device
                        class, country, Core Web Vitals, and frontend errors. Analytics records do not store cookies, visitor or
                        session identifiers, raw IP addresses, precise location, complete referrer URLs, user-agent strings,
                        form contents, or private-gallery activity. Country is reduced to a country code at the website edge,
                        and daily aggregate counters expire after 400 days. AWS may separately retain limited network and
                        security logs, including source IP addresses, to operate and protect the website.
                    </p>
                    <div className="mt-5 rounded-xl border border-warm-border bg-white/50 p-5">
                        <p className="text-sm text-warm-gray">
                            Current setting: <strong className="text-charcoal">{analytics.enabled ? 'Aggregate analytics allowed' : 'Aggregate analytics disabled'}</strong>
                            {analytics.source === 'privacy-signal' ? ' (your browser privacy signal is being honored)' : ''}.
                        </p>
                        <div className="mt-4 flex flex-wrap gap-3">
                            <button type="button" onClick={() => chooseAnalytics(true)} className="rounded-lg border border-charcoal px-4 py-2 text-sm text-charcoal hover:bg-charcoal hover:text-white transition-colors">
                                Allow aggregate analytics
                            </button>
                            <button type="button" onClick={() => chooseAnalytics(false)} className="rounded-lg border border-warm-border px-4 py-2 text-sm text-charcoal hover:border-charcoal transition-colors">
                                Opt out
                            </button>
                        </div>
                    </div>
                </section>

                <section>
                    <h2 className="font-serif text-2xl font-semibold text-charcoal mb-3">Service providers</h2>
                    <p>
                        The site uses Amazon Web Services for hosting, authentication, application data, operational logs, and
                        media delivery. Cloudflare Turnstile helps protect login and contact forms and may process network and
                        device information under Cloudflare's privacy terms. Email delivery providers process messages needed to
                        respond or send account and gallery notices.
                    </p>
                    <p className="mt-3">
                        Print ordering is optional and action-gated. Fotomoto is not loaded during ordinary website or private-gallery
                        browsing. If you choose “Order a Print,” the site gives Fotomoto an opaque, low-resolution image reference and
                        temporarily makes the corresponding print-resolution file available through a restricted pickup folder.
                        Fotomoto processes print selections, contact and shipping details, order records, and related device or network
                        information; Stripe processes payment information. Private album addresses, share codes, account tokens, and
                        the site's original media paths are not sent to Fotomoto.
                    </p>
                </section>

                <section>
                    <h2 className="font-serif text-2xl font-semibold text-charcoal mb-3">Retention and sharing</h2>
                    <p>
                        Information is kept only as long as reasonably needed to provide gallery access, respond to messages,
                        maintain security, and meet legal obligations. Personal information is not sold. It is shared only with
                        the service providers needed to operate the site or when required by law.
                    </p>
                </section>

                <section>
                    <h2 className="font-serif text-2xl font-semibold text-charcoal mb-3">Your choices</h2>
                    <p>
                        You can ask to review, correct, or delete information associated with you, subject to legitimate legal and
                        security needs. You can also ask for a private gallery or account to be removed.
                    </p>
                </section>

                <section>
                    <h2 className="font-serif text-2xl font-semibold text-charcoal mb-3">Contact</h2>
                    <p>
                        Use the <Link className="text-amber-dark underline underline-offset-4" to="/contact">contact form</Link> for
                        privacy questions or requests. Please do not include passwords or other sensitive information in a message.
                    </p>
                </section>
            </div>
        </div>
    )
}
