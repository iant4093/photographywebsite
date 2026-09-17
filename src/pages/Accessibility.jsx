import { Link } from 'react-router'
import LegalPage, { SupportEmail } from '../components/LegalPage'

export default function Accessibility() {
    return <LegalPage title="Accessibility & Help">
        <section><h2>Access to photographs and services</h2><p>I want visitors to be able to browse photographs, contact me, and order prints. Work on accessibility includes keyboard navigation, visible focus, form labels, image descriptions, and media alternatives. This is an ongoing effort; this page is not a claim that every feature or third-party service meets a particular standard.</p></section>
        <section><h2>Browsing options</h2><p>Use the “Skip to main content” link to move past navigation. Photo viewers support previous/next controls and Escape to close. Standard galleries are available from <Link to="/">Photographs</Link> as an alternative to the immersive gallery. Your browser’s zoom and reduced-motion settings can help adapt the experience.</p><p>Descriptions and captions depend on the content available for each photograph or video. If a description, transcript, caption, or other alternative is missing or insufficient for what you need, contact me for help. Third-party checkout can have limitations outside this site’s controls.</p></section>
        <section><h2>Report a barrier or request assistance</h2><p>Email <SupportEmail subject="Accessibility help" /> with the page or photograph, the difficulty you encountered, and the format or help you need. You may include your browser or assistive technology if useful, but you do not need to disclose a disability or medical information. The <Link to="/contact">contact form</Link> is another option; email is available if its security check is a barrier.</p><p>For print-order assistance, include the photograph and desired product without payment-card details. I will review the issue and work with you on an accessible way to obtain the information or service.</p></section>
    </LegalPage>
}
