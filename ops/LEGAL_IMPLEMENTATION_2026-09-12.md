# Legal and privacy implementation — September 12, 2026

Implementation began September 12; the owner authorized deployment on September 17. No customer-data changes were performed. See the September 17 release record for deployment status. This closes the website implementation work from the [original audit](LEGAL_REVIEW_2026-09-12.md), subject to the factual and operational items below; it is not a legal-compliance certification.

## Owner's confirmed choices

- Oregon-based individual photographer, Ian Truong; no registered entity claimed.
- Publish **iant4093@gmail.com** for privacy, licensing, accessibility, and order support.
- Updated September 17: allow any lawful use of owned photographs, including commercial use, editing, distribution, and resale, without credit or separate permission. Third-party rights are not granted.
- Do not create client contracts or contract templates.

## Website changes

| Area | Implemented behavior |
| --- | --- |
| Privacy | Expanded `/privacy` to describe actual providers, accounts, galleries, infrastructure logs, aggregate analytics, GPC/DNT, optional print processing, Google Drive and independent archives, retention criteria, requests/appeals, children, and changes. |
| Local editor data | Added a working recovery-data removal control to `/privacy`; corrected the editor's misleading “nothing stored” text to disclose browser recovery storage. |
| Photo use | Added `/terms` with the owner's broad no-attribution use grant, third-party rights limits, gallery access rules, and a photograph-concern/removal channel. No invented client agreements or releases. |
| Print orders | Added `/print-policy` with seller/provider roles, checkout review, production/shipping and delay handling, seller refund responsibility and individually reviewed voluntary returns, and direct assistance. Policy links and a persistent Close control remain outside the vendor iframe; the isolated print bridge also links policies. |
| Contact | Added the monitored email as a form/security-check alternative and announced form outcomes accessibly. |
| Accessibility | Added `/accessibility`, authored photo descriptions in public/private/shared gallery controls and viewers, and admin tools for descriptions, video WebVTT captions/language, and transcripts. Video controls can toggle native captions and expose a transcript; track-load failures report an alternative. |
| Metadata storage | Extended the existing admin-only media update and both media serialization paths. Inputs are bounded and validated; conditional writes reject a stale manifest position. Existing authorization and public-cache invalidation remain in use. |
| Deletion operations | Admin prompts now explain that deleting website accounts/albums does not automatically erase Drive archives, email, or vendor records. Added a documented request process covering those systems. |
| Software notices | Added `/licenses` and a build-generated full notice bundle covering 35 bundled npm/font packages plus native-runtime notices. Missing package notices and changed RAW source/artifact checksums fail the build. |
| RAW source distribution | Replaced the npm package's undocumented native binary with a compatible core built from published LibRaw 0.22.2 source under CDDL-1.0. Distributed matching source, adapter, build instructions, flags, checksums, and runtime licenses. The JavaScript worker/client remains MIT-licensed; no `unsafe-eval` permission was introduced. |

All policy pages are linked in the footer, share readable layouts, and set descriptive document titles.

## Research and factual limits

The implementation uses the actual code/data flows and the owner's answers. Primary references and their application are recorded in [legal operations](LEGAL_OPERATIONS.md) and [privacy requests](PRIVACY_REQUESTS.md), including Oregon DOJ and Secretary of State, California's privacy-notice statute, FTC shipping guidance, DOJ accessibility guidance, Fotomoto's own terms/privacy/returns/support pages, and LibRaw's published source/licenses.

The notice avoids assuming that the OCPA/CCPA applies solely because the site exists, inventing fixed retention periods for unverified vendor settings, or claiming all photo permissions are on file. The first-party analytics opt-out does not purport to control vendor tracking.

## Verification

- Node 24.19.0: `npm run verify:ci` passed: **111 test files / 1,112 tests**, frontend coverage gates, lint, and production build. Statement coverage 91.17%; branch coverage 83.86%.
- After the final editor wording correction, its **13 tests** passed again, followed by a successful production rebuild.
- Backend: **639 tests** passed, with the repository coverage gate passing at **89.80% line / 81.75% branch** coverage. The metadata tests cover normalization, validation, clearing, normalized-store updates, and stale-position protection.
- `npm run test:raw-decoder` passed on Node 24: actual native decoding of an original synthetic DNG, pixel output, rejected invalid input, reset, and CSP compatibility. This smoke test also runs in the existing CI quality workflow.
- Browser: local RAW file selection decoded successfully at 128 × 96; privacy opt-out visibly disabled analytics; the recovery-data control cleared the synthetic session. Privacy and mobile terms layouts were reviewed, including no horizontal overflow at 390 px.
- Browser: tested the actual print modal at 390 px with a missing-session bridge (no order or vendor account changes). Policy/support links and Close remained visible and usable.
- Browser: a synthetic local video loaded a native WebVTT track (`readyState=2`), visibly rendered its caption, toggled caption visibility, and opened the transcript. Temporary test harness files were excluded from production.
- The build retains its existing warnings about large Three.js/HLS chunks; this change does not claim to resolve those unrelated bundle sizes.

## Owner-dependent follow-through

Use [legal operations](LEGAL_OPERATIONS.md) for continuing work. The owner confirms people posted agree to publication; broader use and vendor-specific permissions still need review where applicable, and actual descriptions, caption timing, transcripts, and any necessary music rights cannot be inferred from site terms. The new authoring controls do not automatically describe or caption existing media. No client contracts were created.

Review the real Fotomoto store's identity, shipping estimates, taxes, and return settings before accepting orders under the revised information. Actual annual data counts determine privacy-law scope; local business requirements depend on where and how paid work is conducted. These facts were not supplied or verified in connected vendor accounts.

Deploy the backend metadata changes before using the new authoring UI, then deploy the frontend and verify live policy/source-download links and the real checkout. Follow the privacy-request procedure when requests arrive, including backup handling and any legally required notices.
