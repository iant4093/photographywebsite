# Website legal review — September 12, 2026

**Follow-up:** This records the original audit. The owner subsequently confirmed Oregon, individual operation, the support email and, on September 17, broad photograph reuse without attribution, and declined client contracts. See [the implementation record](LEGAL_IMPLEMENTATION_2026-09-12.md) and [ongoing operations](LEGAL_OPERATIONS.md) for fixes and remaining owner-dependent work.

Review of Ian Truong Photography for a US-based business serving mainly US customers, as confirmed by the owner. The live `/privacy` page was inspected and matched the local notice. Public routes, contact handling, analytics, print integration, media deletion/backups, editor storage, and selected accessibility and dependency-license code were also reviewed.

This is a practical issue-spotting review, not a legal opinion or compliance certification. The business's state, revenue, customer-data volumes, contracts, releases, vendor account settings, and complete checkout were not verified. California rules below are relevant examples where California residents or uses are involved, not an assumption that the business is based there. No production changes or purchases were made.

**Overall finding:** the site already has useful privacy protections, but its disclosures have not fully kept up with its features. Prioritize privacy/retention accuracy and print-sale information, then photo-use terms, release records, accessibility, and distributed software licenses.

| Area | Assessment | Next action |
| --- | --- | --- |
| Privacy notice and form notice | Present; incomplete | Explain backups, local editor storage, policy updates, and privacy-signal behavior. |
| Retention and deletion | Operational gap to resolve | Distinguish removing a gallery from erasing associated data and backups. |
| Website terms and photo-use license | No dedicated page found | Set permitted uses and explain how individual client agreements apply. |
| Print-sale information | No shipping/returns links in the site's own print wrapper | Confirm checkout terms and expose applicable policies before purchase. |
| Client contracts and model releases | Cannot be established from repository | Verify actual records and permitted publication/marketing uses. |
| Accessibility | Specific issues visible in code | Improve photo descriptions and review video alternatives and the full customer journey. |
| Third-party software licenses | Notices exist; distribution evidence incomplete | Package required licenses and document the LibRaw compliance route. |

**What is already in place**

- The footer links to a dated privacy notice. The contact form gives a collection-purpose notice and links to it.
- The notice covers contact details, client sign-in, galleries, AWS, Cloudflare Turnstile, email providers, Fotomoto, and Stripe.
- First-party analytics have an opt-out. `src/utils/analytics.js` honors Global Privacy Control and Do Not Track, with either signal overriding a saved analytics opt-in. The aggregation code uses restricted event fields and a 400-day expiry target. Security processing separately uses IP-derived rate-limit identifiers.
- Fotomoto is loaded only after a print request, through a separate origin. Its initial image is an opaque low-resolution reference; print-ready files are manually supplied after an order.
- Copyright identification, form labels, lightbox focus handling, and keyboard controls already exist. These are useful foundations, not proof of complete legal or accessibility compliance.

**1. Complete the privacy notice — highest priority**

Evidence: `src/pages/Privacy.jsx:26`, `src/pages/Privacy.jsx:63`, `src/pages/Privacy.jsx:81`; live [privacy notice](https://iantruongphotography.com/privacy).

The notice omits Google Drive media backups. `ops/DRIVE_BACKUP_SYNC.md:24` describes uploads of originals, while line 30 explicitly states that whole-album deletion preserves the Drive folder. Explain what is backed up, its purpose, who processes it, and how removal requests affect those copies. Naming Google would make this clearer; laws requiring recipient categories do not necessarily require every vendor's name.

The public editor saves the selected image and editing state in IndexedDB for recovery (`src/editor/sessionStore.js`, `src/pages/Editor.jsx`). Explain this local persistence and how to clear it. The current notice mentions only sign-in and appearance storage. Explain the stored analytics preference too.

Add the responsible operator/business name and a monitored privacy email as an alternative to the CAPTCHA-protected form. The footer identifies Ian, but the policy can identify the responsible party more directly. Naming Resend and the receiving email service would improve transparency about the contact flow (`backend/functions/email_helpers.py`, `backend/functions/contact.py`); the existing generic email-provider category is already a partial disclosure.

Add a policy-change notification process and an explicit effective/revision date. State in plain language that GPC and DNT disable the site's aggregate analytics, and explain the scope of that choice. Check and disclose whether third parties collect activity across sites; do not assume the first-party opt-out governs all vendor processing. Link applicable vendor privacy notices, including the [Turnstile addendum](https://www.cloudflare.com/turnstile-privacy-policy/).

For commercial sites collecting identifying information from California residents, CalOPPA requires a conspicuous policy describing data and recipient categories, any review/change process, material-change notifications, and an effective date. It also addresses third-party cross-site collection and, conditionally, DNT handling. The absent material-change process is a specific gap if the law applies. [California BPC §22575](https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=BPC&sectionNum=22575.)

**2. Make deletion and retention match the explanation**

Evidence: `ops/DRIVE_BACKUP_SYNC.md:30`, `backend/functions/delete_album.py:68`, `backend/functions/delete_user.py`, `ops/FOTOMOTO_PRINTS.md`.

The gallery deletion function deliberately retains Drive backups. The user-deletion function reviewed removes Cognito identity and gallery data but contains no Drive cleanup. Fotomoto reference copies can remain for approximately 30 days after redemption, even after access is revoked; vendor-held order data and manually supplied print files have separate retention.

Write an internal privacy-request procedure that covers gallery data, backups and archives, contact emails, vendors, and security/order records. Distinguish legitimate retention from records that should be erased. Track any exception and communicate it; do not describe the ordinary admin delete button as erasing every copy.

Decide retention periods or workable criteria by category. Infrastructure defaults suggest 30 days for API/application logs and 90 days for media logs, but live parameter values and other security logs were not verified. Do not publish those numbers until confirmed. Expiry policies also need to account for provider deletion delays.

The current notice permits deletion requests subject to legal/security needs, so this review does not establish a broken promise of immediate total erasure. It identifies a workflow and explanation that need completing. Privacy promises must accurately reflect actual practices. [FTC privacy and security guidance](https://www.ftc.gov/business-guidance/privacy-security)

**3. Add website terms and a photo-use license — recommended protection**

Evidence: `src/App.jsx`, `src/components/Footer.jsx`, and the download/print controls in `src/components/PhotoLightbox.jsx`. No dedicated terms, licensing, or returns routes were found.

Explain permitted personal use, commercial licensing requests, attribution where required by the license, editing/reposting permissions, and client download permissions. Make clear that purchasing a physical print does not itself transfer copyright. State how a signed client agreement governs the delivered photographs. Include reasonable account/share-link rules and service limitations; have counsel review any liability limits or dispute provisions. A footer link alone should not be assumed to establish agreement to consequential contract terms.

A Terms page is not universally mandatory for every US portfolio. Its value here is clarifying actual download, sharing, gallery, and purchase expectations. Copyright normally arises on creation; a copyright footer is not a license granting customers permission to reuse photographs. [US Copyright Office guidance for photographers](https://www.copyright.gov/engage/photographers/)

**4. Make print-sale information accessible before payment**

Evidence: `print.html:23`, `src/components/PrintOrderModal.jsx`, `ops/FOTOMOTO_PRINTS.md`.

The site's wrapper says Fotomoto handles payment, production, and shipping, but has no direct shipping, returns, cancellation, or purchase-terms links. Vendor checkout may contain some of this; it was not fully inspected. Confirm who the seller is and provide the applicable policy links, order-support route, production/shipping expectations, and damaged/wrong-item process. Ensure total charges are clear before payment. Confirm state-specific tax and seller-registration responsibilities separately using the actual business location and vendor setup.

**September 17 correction:** Fotomoto’s support refund policy updated February 18, 2026 assigns refund responsibility to the seller, conflicting with its older 30-day marketing page. The implemented policy uses the newer support information and does not promise a universal 30-day return. Verify the terms applicable to the configured store before adopting a policy, particularly before claiming custom prints are nonreturnable. [Fotomoto purchase and refund information](https://www.fotomoto.com/help/confidence)

The manual step of supplying print-ready files must fit promised dispatch times. The FTC merchandise rule generally requires a reasonable basis for the advertised shipping time, or 30 days when no time is stated; qualifying delays require consent or refund handling. Outsourced fulfillment does not justify ignoring the seller's applicable duties. [FTC merchandise-order rule guide](https://www.ftc.gov/business-guidance/resources/business-guide-ftcs-mail-internet-or-telephone-order-merchandise-rule)

**5. Verify photography contracts and publication permissions**

The repository cannot establish whether signed booking contracts or model releases already exist. Check booking/payment/cancellation provisions, delivery and archive duration, client usage rights, and permission to use client images in advertising or public portfolio promotion. Keep appropriate parent/guardian authorizations for minors. Review third-party music and other copyrighted material in videos as well.

Owning a photograph's copyright does not settle the subject's publicity/privacy rights. For example, California regulates certain advertising and merchandise uses of an identifiable person's likeness without consent, including parental/guardian consent for minors, with exceptions. This does not mean every street, editorial, or artistic photograph needs a release; use and jurisdiction matter. [California Civil Code §3344](https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=CIV&sectionNum=3344.)

**6. Improve accessibility in the product**

The main lightbox image uses the generic `alt="Full size preview"` (`src/components/PhotoLightbox.jsx:377`). It does not describe the photograph. `src/components/VideoPlayer.jsx:88` has no explicit caption-track support in its markup; existing videos may have embedded/burned-in captions, which were not checked.

Add useful photo descriptions and support captions/appropriate alternatives for meaningful video audio and visual information. Check keyboard use, screen-reader form errors, contrast, zoom, and third-party checkout. Offer an accessibility contact route. An accessibility statement can explain support, but cannot repair inaccessible functionality.

DOJ considers ADA obligations applicable to web services of covered public accommodations. Exact application to this business is fact- and jurisdiction-dependent; WCAG is useful technical guidance, not a compliance guarantee from a code spot-check. [DOJ web accessibility guidance](https://www.ada.gov/resources/web-guidance/)

**7. Complete third-party software license distribution**

`THIRD_PARTY_NOTICES.md` lists LibRaw/rawconvert-wasm and exifr but mainly points to upstream projects or locally installed package metadata. No separate license/notice files were found by filename in the existing `dist` output; some notices may survive inside JavaScript, and a full bundle/license audit was not performed. The font packages also include license files locally.

Inventory what is actually delivered to browsers and preserve applicable copyright/license texts. Identify the exact LibRaw version and corresponding source for the shipped WASM and document whether compliance uses LGPL-2.1 or CDDL-1.0. A separately loaded module does not, by itself, resolve every obligation. LibRaw offers the license choice, and CDDL includes source-availability and notice conditions for covered executable distribution. [LibRaw licensing](https://www.libraw.org/about), [LibRaw CDDL license](https://github.com/LibRaw/LibRaw/blob/master/LICENSE.CDDL).

Also clarify the notice's description of an “unmodified decoder”: `scripts/patch-rawconvert-csp.mjs` patches its JavaScript glue during build, although that does not establish a modification to LibRaw's underlying C++ source.

**Conditional requirements, not automatic missing pages**

- CCPA/CPRA applicability needs actual business facts. The principal thresholds include the adjusted annual revenue threshold of $26.625 million, buying/selling/sharing data of 100,000 California residents or households, or deriving at least 50% of revenue from selling/sharing that data; there are additional entity relationships and service-provider rules. Ordinary visitor count alone is not the 100,000-person test. CalOPPA is a separate law without those same size thresholds. Other state laws require a separate applicability check. [CalPrivacy applicability FAQ](https://cppa.ca.gov/faq), [adjusted monetary thresholds](https://cppa.ca.gov/regulations/cpi_adjustment.html)
- A generic cookie banner is not the main gap established by this review. Preserve the existing privacy controls and review actual vendor storage/tracking, audience, and applicable rules before choosing a consent interface. “Cookie-free analytics” does not mean the entire site has no local storage or vendor data processing. Broader EU/UK targeting would need a separate review.
- Children appearing in photographs do not automatically make this a COPPA-covered service. Child-directed services and knowing collection from under-13 users need separate attention; the FTC distinguishes adult uploads of children's photos to general-audience services. [FTC COPPA FAQ](https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions)
- No newsletter or advertising pixel was found in the inspected first-party code. Reassess marketing opt-outs, disclosures, and tracking controls if those features are added.

Before finalizing public text, resolve the business state/legal name, monitored privacy contact, actual backup/archival retention decisions, print-store terms, and contract/release records. These are factual inputs; a generic policy generator cannot supply them reliably.
