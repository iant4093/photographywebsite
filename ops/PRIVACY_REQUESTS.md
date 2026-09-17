# Privacy requests and retention

Owner: Ian Truong, Oregon. Public contact: iant4093@gmail.com. Adopted September 12, 2026.

The privacy notice describes a human-reviewed process. The normal album/account delete buttons do not erase every backup or vendor record. Do not acknowledge complete erasure based only on those buttons. This procedure does not authorize deleting unrelated media or keeping everything indefinitely.

## Intake and response

1. Monitor the published email address and contact-form inbox. Record receipt date, request type, requester contact, an opaque case number, and the response deadline in a private case file. Never commit real case files, identities, account tokens, gallery links, or evidence to this repository.
2. Establish the request's scope: information access/copy, correction, gallery removal, erasure, objection/opt-out, photograph concern, or appeal. Explain any ambiguity without making the person restart their request.
3. Verify proportionately using the existing account/contact relationship. Confirm an agent's authority when necessary. Do not request passwords or copies of identity documents by default. Never disclose someone else's gallery during verification. A simple request to stop optional tracking does not need an account or identity documents.
4. Determine applicable deadlines. For covered Oregon requests, the response period is 45 days; a justified additional 45 days requires timely notice and an explanation. Appeals receive a written decision within 45 days. Route other jurisdictions to their applicable deadlines; do not assume Oregon timelines apply everywhere. Use an internal 7-day intake target and 30-day substantive-response target to leave time to resolve problems. These targets are operational goals, not an assertion that the law mandates them. [Oregon DOJ consumer FAQ](https://www.doj.state.or.us/consumer-protection/id-theft-data-breaches/privacy/privacy-law-faqs-for-consumers/)
5. For an appeal, reply to the original decision or accept email headed “Privacy appeal.” Reassess the reasons and record a written outcome. If rejecting an Oregon appeal, include the Oregon DOJ complaint information linked in its FAQ.

## Inventory before removal

Create a private inventory before deleting gallery/account records, so the mapping to backups is retained long enough to complete the request. Use exact account subject, album ID, media IDs, verified Drive folder/file IDs, and order numbers. Do not match or delete solely by a person's common name.

| System | Review/action |
| --- | --- |
| Cognito and album/media records | Find accounts, owner assignments, all owned galleries, and relevant individual photographs. Check access and share grants. |
| S3 and media delivery | Locate originals, thumbnails, previews, original-comparison derivatives, ZIPs, all object versions, and relevant cache entries. Use the existing version-aware deletion and invalidation procedures; verify public copies stop resolving. |
| Google Drive backups | Whole-album deletion preserves this folder. Record verified root ancestry and IDs first. Distinguish synchronized backup copies from unrelated files, manual extras, and archives. Remove applicable copies separately; include Trash/retained versions in the review. |
| Original-comparison archives | Inspect separately from the website backup root. These are deliberately outside ordinary gallery-sync deletion. Determine whether retained originals are necessary and legally permitted. |
| Fotomoto references | Review opaque preview copies created by print redemption; the ordinary lifecycle targets approximately 30 days plus provider cleanup. For an urgent deletion, identify the exact related reference safely and arrange removal; gallery revocation alone is insufficient. |
| Fotomoto/Bay Photo and Stripe | Identify orders and print-ready uploads. Request deletion/correction where applicable; distinguish fulfillment copies from records the vendor must retain. Record confirmations and exceptions. Do not email card details. |
| Gmail and Resend | Locate the relevant inquiry, correspondence, sent copies, delivery records, and Trash. Keep only what is necessary for a documented exception. |
| Logs and recovery backups | Verify actual configured retention, access restrictions, and incident/legal holds. Where permitted, let protected backups expire, and maintain a minimal suppression record so restored systems do not reactivate deleted information. |

For media involving multiple people, verify scope and the rights of others before removing an entire shared album. A photo-removal request is not necessarily a request to delete the photographer's account, all original photographs, or all records of a transaction.

## Execution and verification

Use existing authenticated admin tools or maintenance procedures only for the exact approved scope. Check failures, retries, caches, and provider responses. Preserve a minimal private suppression record for any backup restoration. Never copy private records into public legal pages, build artifacts, or the source repository.

For each retained category, record the concrete reason, access restriction, and next review/expiry date. “A backup exists” alone is not a legal exception. Explain remaining copies, expected expiry, and exceptions to the requester without exposing security-sensitive system details. Respond to access requests using an appropriate private delivery channel.

Close a case only after completing the applicable actions or explaining any lawful refusal/partial completion. Keep only minimal case evidence for necessary accountability and dispute handling; review it for deletion when its purpose ends. Actual retention periods must reflect accounting, legal, and business needs rather than an invented universal number.

## Routine retention review

Review unnecessary inquiry threads, unused client accounts, expired delivery galleries, backups/archives, and closed cases periodically. Record decisions privately. Confirm actual production log settings before making numerical promises; template defaults are not proof of deployed retention. Analytics counter TTL is 400 days and Fotomoto reference lifecycle is 30 days, with service cleanup delays possible. Recheck those values when infrastructure changes.

## Case record fields (private storage only)

Case number; received date; applicable jurisdiction/deadline; verified contact/authority; requested scope; affected systems and exact identifiers; actions and confirmations; retained categories and reasons; expiry/review dates; requester response; appeal status; closure date; backup-restoration suppression reference.
