# Legal and accessibility operations

Owner decisions updated September 17, 2026: Ian Truong is an individual photographer in Oregon, with no registered entity; publish iant4093@gmail.com for support; permit any lawful use of owned photographs, including commercial use, without requiring credit or separate permission; do not create client contracts or contract templates.

## Business identity and scope

The public pages identify the operator as Ian Truong, not an LLC or corporation. Oregon's Secretary of State says a sole proprietor using the owner's real and true name generally does not need assumed-name registration with that office. This does not determine local permits, tax registrations, or other requirements. “Ian Truong Photography” includes the supplied name. Check city/county requirements separately if conducting paid business. [Oregon registration guidance](https://sos.oregon.gov/business/information-center/pages/doing-business-means.aspx)

OCPA applicability still requires actual consumer-data counts and business facts. Principal thresholds are 100,000 consumers, or 25,000 plus over 25% of gross revenue from personal-data sales, subject to the statute's counting rules and exemptions. Do not measure this solely from anonymous aggregate pageview counts. Check annual applicability and whenever processing changes. Covered operators must honor universal opt-outs from January 1, 2026. The site already honors GPC/DNT for its aggregate analytics. [Oregon DOJ business FAQ](https://www.doj.state.or.us/consumer-protection/for-businesses/privacy-law-faqs-for-businesses/)

CalOPPA is separate and may apply when a commercial site collects identifying information from California residents, without the CCPA's same size tests. Its notice requirements informed the revision. This is not a conclusion that every US state privacy law applies. [California BPC §22575](https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=BPC&sectionNum=22575.)

## Photographs and permissions

The owner confirms that the people he publishes agree to being posted. This is recorded as his statement, not a finding that written releases exist or that every downstream use is cleared. Being photographed in public alone is not treated as consent. No contracts were created, as requested. Do not claim that releases are on file when they are not. Review identifiable portraits before using them in advertisements or other uses that need consent. Ask for the relevant person's permission (and a parent/guardian's permission where needed for a minor); retain an appropriate private record of what use was permitted. Ordinary editorial/street/artistic uses require context-specific judgment. The public licensing text governs visitors' copyright permission; it cannot grant the photographer another person's publicity/privacy rights or clear music owned by someone else.

For existing media, review the actual intended use and any recorded permission; handle concerns received through the published photograph-removal email. A removal channel is not a substitute for consent where consent is required. Avoid inferring permission from attendance at an event or access to a private gallery. No existing photographs or permission records were changed by this implementation.

## Print orders

Review incoming paid orders promptly and provide the print-ready file to Fotomoto in time for the quoted shipment schedule. Review the configured checkout's seller identity, products, prices, crop controls, shipping destinations, taxes, and customer-visible return terms. Do not assume connecting Stripe resolves tax or seller-registration duties.

The public policy identifies Ian as seller and uses Fotomoto's support refund policy updated February 18, 2026: Fotomoto coordinates issues, while the seller is responsible for refunds. An older marketing page still advertises 30-day returns; do not treat that as a verified store guarantee. Change-of-mind requests are considered individually, approved terms must be confirmed in writing, and any more favorable terms offered with the order must be honored. Statutory remedies remain intact. [Current refund support policy](https://support.fotomoto.com/hc/en-us/articles/41715076303379-Fotomoto-Refund-Policy)

Follow [the researched Fotomoto guide](FOTOMOTO_PRINTS.md) for account setup, fees, file delivery, and customer service. Dashboard login was unavailable during the September 17 review, so connected payments, billing, products, prices, taxes, and fulfillment settings remain unverified. Fotomoto's terms impose content-permission/release obligations of their own; permission to post someone does not establish every permission needed to sell their image through that vendor. [Vendor terms](https://www.fotomoto.com/help/terms)

Track the applicable shipping deadline from the properly completed order. If no shipment time was stated for a covered US order, the FTC default is generally 30 days. Give required delay notices and refund options on time; route each case through Fotomoto and confirm resolution. Never treat an unread vendor notification as automatic customer consent. [FTC merchandise-order guide](https://www.ftc.gov/business-guidance/resources/business-guide-ftcs-mail-internet-or-telephone-order-merchandise-rule)

## Privacy operations

Follow [the request procedure](PRIVACY_REQUESTS.md). Review Google Drive and independent original archives separately from website-gallery deletion. The revised admin prompts explain this distinction. Do not publish made-up fixed retention periods or assert total erasure while retained copies still exist.

A policy notice is not consent. Before adopting materially different processing, determine what notice/consent is needed, update the policy and change summary, and deliver additional notices where required. The revised page does not automatically notify existing clients by email. No such messages were sent as part of this work.

Fotomoto's own privacy policy describes third-party analytics and marketing cookies. Loading it only after an order action reduces unsolicited third-party exposure; it is not proof of compliance in every jurisdiction or proof that the vendor has no tracking. Reassess if targeting EU/UK customers or enabling advertising. [Fotomoto privacy policy](https://www.fotomoto.com/help/privacy)

## Accessible content maintenance

In Manage Albums, use each item's **Describe** button to save accurate alt text. For videos, supply a short description, a WebVTT caption file with accurate timings and meaningful audio, a correct language tag, and a transcript/visual description as appropriate. Do not invent identities, emotions, or details that have not been observed. Omit unnecessary sensitive details from descriptions.

Existing uncaptioned videos and photographs without authored descriptions still require content review. The fallback image label provides album/position context; it is not a visual description or proof of WCAG conformance. Check captions against the actual audio, verify important visual information has an accessible alternative, and recheck mobile/keyboard/screen-reader use after changes. Caption/transcript inputs have size limits to keep media records bounded; long videos may require a future external caption-file workflow.

The site provides a direct email alternative for contact and print help, an accessibility page, caption controls, and transcript support. Third-party checkout still needs periodic manual accessibility testing. [DOJ accessibility guidance](https://www.ada.gov/resources/web-guidance/), [WebVTT specification](https://www.w3.org/TR/webvtt1/)

## Before deployment

Run the frontend checks and relevant backend tests. Deploy the backend metadata changes before relying on the new description/caption authoring UI, then deploy the frontend and verify production policy and license links. Check the real print checkout without making a purchase. Production deployment was authorized by the owner on September 17 and uses the normal guarded main-branch release. Business registration, customer messages, and customer-data erasure are not part of this release.
