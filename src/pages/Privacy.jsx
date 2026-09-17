import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import LegalPage, { SupportEmail } from '../components/LegalPage'
import { clearEditorSession } from '../editor/sessionStore'
import { analyticsPreference, setAnalyticsPreference, subscribeToAnalyticsPreference } from '../utils/analytics'

export default function Privacy() {
    const [analytics, setAnalytics] = useState(analyticsPreference)
    const [clearing, setClearing] = useState(false)
    const [storageNotice, setStorageNotice] = useState('')
    useEffect(() => subscribeToAnalyticsPreference(() => setAnalytics(analyticsPreference())), [])

    const chooseAnalytics = enabled => {
        setAnalyticsPreference(enabled)
        setAnalytics(analyticsPreference())
    }
    const clearSavedPhoto = async () => {
        setClearing(true)
        try {
            await clearEditorSession()
            setStorageNotice('The saved editor session was cleared from this browser. Your original files are unchanged.')
        } catch {
            setStorageNotice('The saved session could not be cleared here. Close other editor tabs and use your browser’s site-data settings.')
        } finally { setClearing(false) }
    }

    return (
        <LegalPage title="Privacy Notice">
            <section>
                <h2>Who operates this site</h2>
                <p>Ian Truong Photography is operated by Ian Truong, an individual photographer based in Oregon, United States. This notice covers this website, client galleries, inquiries, and the site’s print-order integration. Contact <SupportEmail subject="Privacy request" /> for privacy questions or requests.</p>
            </section>
            <section>
                <h2>Information this site uses</h2>
                <ul>
                    <li><strong>Inquiries:</strong> your name, email address, message, and subsequent correspondence, used to respond and discuss photography services. Messages are delivered by email; submitting an inquiry does not subscribe you to marketing.</li>
                    <li><strong>Client access:</strong> email addresses, account identifiers, authentication records, and assigned galleries, used to sign you in, deliver media, and protect access. AWS Cognito handles authentication.</li>
                    <li><strong>Photographs and videos:</strong> images, voices where recorded, album information, descriptions, and associated camera or capture metadata, used for display, delivery, editing comparisons, backup, and requested prints. Original files may retain metadata that does not appear in the gallery.</li>
                    <li><strong>Operation and security:</strong> request and device/network information, including IP addresses in infrastructure logs and protected IP-derived rate-limit identifiers, used to deliver content, prevent abuse, and investigate errors.</li>
                </ul>
                <p>Public albums are visible to other visitors. People with a shared-album link or code can access the content it unlocks; keep it private if you do not want it forwarded. Downloaded or reposted copies are outside the site’s control.</p>
            </section>
            <section>
                <h2>Aggregate website analytics</h2>
                <p>This site uses first-party, cookie-free analytics to count public page loads, album views, downloads, contact-form completions, homepage exploration clicks, approximate traffic-source categories, device class, country, Core Web Vitals, and frontend error categories. Analytics records do not store cookies, visitor or session identifiers, raw IP addresses, precise location, complete referrer URLs, user-agent strings, form contents, or private-gallery activity. Country is reduced to a country code at the website edge. Daily counters are scheduled to expire after 400 days; provider cleanup can take additional time. Security and delivery logs are separate from these counters.</p>
                <p>Aggregate analytics are enabled by default unless you opt out or your browser sends Global Privacy Control (GPC) or Do Not Track (DNT). Either signal disables these analytics, even if you previously allowed them. This choice applies to this browser and this site’s analytics; necessary security processing and third-party checkout have separate controls.</p>
                <div className="legal-controls">
                    <p role="status">Current setting: <strong>{analytics.enabled ? 'Aggregate analytics allowed' : 'Aggregate analytics disabled'}</strong>{analytics.source === 'privacy-signal' ? ' (your browser privacy signal is being honored)' : ''}.</p>
                    <div className="legal-controls-actions">
                        <button type="button" onClick={() => chooseAnalytics(true)}>Allow aggregate analytics</button>
                        <button type="button" onClick={() => chooseAnalytics(false)}>Opt out</button>
                    </div>
                </div>
            </section>
            <section>
                <h2>Browser storage and the photo editor</h2>
                <p>The browser stores sign-in, appearance, and analytics preferences. The photo editor processes selected files on your device and saves an image and editing settings in this browser for session recovery. Selecting a file in the editor does not upload it to the gallery or send it to the photographer. Local recovery data remains until it is replaced, cleared in the editor, cleared below, or removed through browser site-data controls. Clearing browser data can also sign you out and reset preferences.</p>
                <div className="legal-controls">
                    <p>Close other editor tabs before clearing recovery data so they cannot save the session again.</p>
                    <div className="legal-controls-actions"><button type="button" disabled={clearing} onClick={clearSavedPhoto}>{clearing ? 'Clearing…' : 'Clear saved editor session'}</button></div>
                    <p role="status">{storageNotice}</p>
                </div>
            </section>
            <section>
                <h2>Service providers and sharing</h2>
                <ul>
                    <li><a href="https://aws.amazon.com/privacy/">Amazon Web Services</a> provides hosting, authentication, application storage, media delivery, and operational/security services.</li>
                    <li><a href="https://policies.google.com/privacy">Google</a> provides Drive storage for selected media backups and archives, and Gmail for correspondence.</li>
                    <li><a href="https://resend.com/legal/privacy-policy">Resend</a> delivers contact-form messages and account/gallery emails.</li>
                    <li><a href="https://www.cloudflare.com/turnstile-privacy-policy/">Cloudflare Turnstile</a> processes network and browser signals to protect forms and improve bot detection. It is loaded on protected forms, including login and contact.</li>
                    <li><a href="https://www.fotomoto.com/help/privacy">Fotomoto/Bay Photo</a> handles optional print orders. Payment providers, such as <a href="https://stripe.com/privacy">Stripe</a> or <a href="https://www.paypal.com/us/legalhub/paypal/privacy-full">PayPal</a>, process payment information when offered and used at checkout.</li>
                </ul>
                <p>I do not sell personal information or use the site’s first-party analytics for advertising across other websites. Information is disclosed to providers as needed for the activities described here, and when reasonably necessary to comply with law or protect rights and security. Public photographs are also disclosed to the audiences for which they are published.</p>
                <p>Providers may process information in the United States and other countries where they operate. Third-party services may collect device, network, and browsing information over time or across websites under their own policies. In particular, Fotomoto’s policy describes cookies and third-party analytics/marketing tools. The site’s analytics opt-out does not control those services. Links to Instagram and GitHub take you to services with their own privacy practices.</p>
            </section>
            <section>
                <h2>Optional print ordering</h2>
                <p>Fotomoto is not loaded during ordinary website or private-gallery browsing. When you choose “Order a Print,” an isolated print page sends Fotomoto an opaque low-resolution image reference. Private album addresses, share codes, account tokens, and original media paths are not provided to Fotomoto. If you place an order, I manually supply the corresponding print-ready file to Fotomoto. It processes product selections, contact and shipping details, order records, and device/network information; the payment provider selected in checkout processes payment details.</p>
                <p>The low-resolution reference is scheduled for deletion after 30 days, with provider cleanup delays possible. Revoking gallery access does not immediately remove a reference already created or data already received by the print provider. See <Link to="/print-policy">print orders and returns</Link> for purchase and support information.</p>
            </section>
            <section>
                <h2>Retention, backups, and deletion</h2>
                <p>Contact correspondence is retained as needed to answer inquiries, provide requested services, and resolve related issues. Account and gallery records are retained while providing access and for necessary administration. Media backups and archives support recovery, later delivery, and editing comparisons. Security records follow configured retention and investigation needs. Order, payment, and dispute records may need to be kept for tax, accounting, fraud prevention, or legal obligations.</p>
                <p>Removing a gallery or account from the website does not automatically erase Google Drive backups, separate original archives, email correspondence, or print-provider records. A request to delete personal information is reviewed across those systems separately. Where information must be retained, I will explain the reason when responding. Backup expiry and provider deletion may take additional time. If a backup is restored, applicable deletion requests will be honored before restored information is returned to active use.</p>
            </section>
            <section>
                <h2>Your choices and requests</h2>
                <p>Email <SupportEmail subject="Privacy request" /> or use the <Link to="/contact">contact form</Link> to request access to, a copy of, correction of, or deletion of information associated with you. You can also request removal of your account, a private gallery, or a photograph in which you appear. Include enough context to locate the records, such as an album link or the email used for your account. Do not send passwords, payment-card details, or identity documents with an initial request.</p>
                <p>I may ask for proportionate information to verify your identity or an agent’s authority before disclosing or deleting records. Available legal rights and exceptions depend on your location and the laws that apply. Where applicable, these may include portability, details about recipients, opting out of sale, targeted advertising or certain profiling, and appealing a denied request. This site does not use your information to make automated decisions about eligibility for employment, credit, or similar opportunities.</p>
                <p>If a request is declined, reply to the decision or email with the subject “Privacy appeal.” Requests and appeals are handled within applicable legal deadlines, with any extension explained. You will not be treated unfairly for exercising applicable privacy rights. You may also contact your state privacy regulator, including the <a href="https://www.doj.state.or.us/consumer-protection/">Oregon Department of Justice</a>.</p>
            </section>
            <section>
                <h2>Children</h2>
                <p>The website is intended for a general audience, not for children under 13 to submit information or create accounts. A parent or guardian can contact me about a child’s information or photograph. If you believe a child under 13 submitted personal information through the site, please contact me so I can investigate and address it.</p>
            </section>
            <section>
                <h2>Changes to this notice</h2>
                <p>Updates are published on this page with a new revision date. Material changes will be called out here and, where required, brought to affected users’ attention through an additional website notice or direct message before the new practice takes effect. Any legally required consent will be requested separately; reading this notice is not consent.</p>
                <p>September 17, 2026: added the Oregon operator and direct contact, explained Drive backups and editor storage, clarified privacy signals and print-provider processing, and expanded the request and retention information.</p>
            </section>
        </LegalPage>
    )
}
