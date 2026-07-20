import { Link } from 'react-router-dom'

export default function Privacy() {
    return (
        <div className="max-w-3xl mx-auto px-6 py-16 pt-[104px] md:pt-[120px] animate-fade-in">
            <h1 className="font-serif text-4xl md:text-5xl font-semibold text-charcoal mb-6">Privacy Notice</h1>
            <p className="text-sm text-warm-gray mb-10">Last updated July 20, 2026</p>

            <div className="space-y-8 text-charcoal-light leading-relaxed">
                <section>
                    <h2 className="font-serif text-2xl font-semibold text-charcoal mb-3">Information this site uses</h2>
                    <p>
                        If you contact me, the site processes the name, email address, and message you submit so I can respond.
                        Client accounts use an email address for sign-in and access to assigned private galleries. Galleries may
                        contain photos, videos, dates, and camera metadata selected for delivery to a client.
                    </p>
                </section>

                <section>
                    <h2 className="font-serif text-2xl font-semibold text-charcoal mb-3">Service providers</h2>
                    <p>
                        The site uses Amazon Web Services for hosting, authentication, application data, operational logs, and
                        media delivery. Cloudflare Turnstile helps protect login and contact forms and may process network and
                        device information under Cloudflare's privacy terms. Email delivery providers process messages needed to
                        respond or send account and gallery notices.
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
