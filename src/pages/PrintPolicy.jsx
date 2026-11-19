import { Link } from 'react-router'
import LegalPage, { SupportEmail } from '../components/LegalPage'

export default function PrintPolicy() {
    return <LegalPage title="Print Orders & Returns" updated="November 18, 2026">
        <section>
            <h2>Ordering a print</h2>
            <p>Choose “Order a Print” on an eligible photograph to open it on Pictorem’s website in a new tab. You place your order directly with Pictorem. Pictorem handles checkout, production, shipping, and order support under its <a href="https://www.pictorem.com/terms.html">sales terms</a>. I may receive a rebate through <a href="https://www.pictorem.com/pro/i/dynamiclink.html">Pictorem’s PRO program</a> when you purchase through a print link. For a private or share-code gallery, clicking sends Pictorem a temporary link to the selected photo. Read the <Link to="/privacy">Privacy Notice</Link> for details about the photo handoff.</p>
        </section>
        <section>
            <h2>Before paying</h2>
            <p>Review the photograph, product, size, crop, quantity, delivery address, and total in Pictorem’s checkout. Available products, sizes, and shipping options depend on the photo and delivery destination. International orders may incur additional duties or taxes. The photograph’s copyright and use permissions are described in <Link to="/terms">Terms & Photo Use</Link>.</p>
        </section>
        <section>
            <h2>Production and shipping</h2>
            <p>Check Pictorem’s <a href="https://www.pictorem.com/shippinginfo.html">shipping information</a> and your order confirmation for timing. Production and shipping transit are separate. Use <a href="https://www.pictorem.com/trackmyorder.html">Pictorem’s order tracker</a> or contact Pictorem about a delay or missing package.</p>
        </section>
        <section>
            <h2>Returns, damaged items, and cancellations</h2>
            <p><a href="https://www.pictorem.com/contact.html">Contact Pictorem</a> with your order number. Its sales terms ask you to report problems within 30 days of delivery and provide for a replacement or full refund for qualifying issues, such as defects or damage in transit. Keep the packaging and any photos of the issue. Ask Pictorem for return authorization before sending anything back.</p>
            <p>Contact Pictorem promptly to change or cancel an order. Its sales terms describe cancellation timing and fees once production starts. Applicable consumer rights still apply.</p>
        </section>
        <section>
            <h2>Help opening print options</h2>
            <p>If the print link on this site is inaccessible or opens the wrong photograph, email <SupportEmail subject="Help opening print options" /> with the gallery link. For checkout issues, contact Pictorem directly.</p>
        </section>
    </LegalPage>
}
