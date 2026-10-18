# Privacy requests and retention

Owner: Ian Truong, Oregon. Public contact: iant4093@gmail.com. Adopted September 12, 2026.

The privacy notice says deletion requests are reviewed across each system separately. The album and account delete buttons on the site do not erase Google Drive backups, separate original archives, email or print-provider records, so do not confirm full erasure based on those buttons alone. This procedure does not authorize deleting unrelated media or keeping everything indefinitely.

## Taking a request and replying

1. Watch the published email address and the contact-form inbox. In a private case file, record the date received, request type, requester contact, an opaque case number and the response deadline. Real case files, identities, account tokens, gallery links and evidence never go in this repository.
2. Identify the request type: access or a copy, correction, gallery removal, erasure, objection or opt-out, a concern about a photograph, or an appeal. If it is unclear, ask, without making the person start over.
3. Verify in proportion to the request, using the existing account or contact relationship. Confirm an agent's authority when it matters. Do not ask for passwords or ID documents by default, and never show someone else's gallery while verifying. A request to stop optional tracking does not need an account or ID.
4. Determine the deadline. For covered Oregon requests it is 45 days, with one further 45-day extension when justified and the person is told in time. Appeals get a written decision within 45 days. Other jurisdictions have their own deadlines; do not assume Oregon's apply everywhere. The internal targets are 7 days to acknowledge and 30 days for a substantive answer. These are operational targets, not legal requirements. [Oregon DOJ consumer FAQ](https://www.doj.state.or.us/consumer-protection/id-theft-data-breaches/privacy/privacy-law-faqs-for-consumers/)
5. For an appeal, the person can reply to the original decision or send an email with the subject “Privacy appeal.” Review the reasons again and record the outcome. If an Oregon appeal is denied, include the Oregon DOJ complaint information linked in that FAQ.

## Find everything before deleting anything

Before deleting gallery or account records, build a private inventory so the mapping to backups is still available later in the request. Use the account subject, album ID, media IDs, verified Drive folder and file IDs, and order numbers. Never match or delete by name alone, since names collide.

| System | What to check and do |
| --- | --- |
| Cognito and album/media records | Find accounts, owner assignments, every gallery they own, and the individual photographs involved. Check access and share grants. Also check Recently Deleted: the Delete button in Manage Albums moves an album there for 30 days, so use "Delete permanently" on that page. Deleting a user account also deletes the albums that user owns, including those in Recently Deleted. |
| S3 and media delivery | Find originals, thumbnails, previews, original-comparison derivatives, ZIPs, every object version and any cached copies. Use the existing version-aware deletion and invalidation procedures, and check that public copies stop resolving. Deleting an album or media also removes its generated comparison previews; older orphans need `ops/sweep_comparison_previews.py` ([MAINTENANCE_AND_RECOVERY.md](MAINTENANCE_AND_RECOVERY.md#generated-original-comparison-cleanup)). |
| Google Drive backups | Deleting an album does not remove its Drive backup folder. Record the verified root ancestry and IDs first. Tell synced backup copies apart from unrelated files, manual extras and archives. Remove the applicable copies as a separate step, and check Trash and old versions too. |
| Original-comparison archives | Check these separately from the website backup root. Normal gallery-sync deletion does not touch them. Decide whether keeping the originals is necessary and legally allowed. |
| Fotomoto references | Print redemption creates opaque preview copies under `fotomoto/references/`, which an S3 lifecycle rule expires after 30 days; provider-side cleanup may take longer. For an urgent deletion, identify the specific reference and arrange removal; revoking the gallery is not enough on its own. |
| Fotomoto/Bay Photo and Stripe | Find the orders and print-ready uploads. Ask for deletion or correction where it applies, and separate fulfillment copies from records the vendor has to keep. Record confirmations and exceptions. Never email card details. |
| Gmail and Resend | Find the inquiry, correspondence, sent copies, delivery records and Trash. Keep only what a documented exception needs. |
| Logs and recovery backups | Check the retention that is actually configured, who can access it, and any incident or legal holds. Where allowed, let protected backups expire, and keep a minimal suppression record so a restore does not bring deleted information back. |

When a photo shows several people, check the scope and the other people's rights before removing a whole shared album. A request to take down a photo is not the same as a request to delete the photographer's account, all the original photos, or every record of a sale.

## Doing it and checking it worked

Use the existing authenticated admin tools or maintenance procedures, and only for the approved scope. Check for failures, retries, caches and provider responses. Keep a minimal private suppression record in case a backup is restored. Private records never go into public legal pages, build artifacts or the source repository.

For each category kept, record the specific reason, who can access it, and the next review or expiry date. The existence of a backup is not a legal exception by itself. Tell the requester what copies remain, when they expire, and what the exceptions are, without revealing security-sensitive details about the system. Send access-request responses through a suitable private channel.

Close a case only after the applicable actions are done, or after explaining any lawful refusal or partial completion. Keep only the minimum case evidence needed for accountability and disputes, and review it for deletion when it is no longer needed. Retention periods come from accounting, legal and business needs; do not apply a single number to everything.

## Routine retention review

Periodically review old inquiry threads, unused client accounts, expired delivery galleries, backups and archives, and closed cases. Record the decisions privately. Check the live log settings before stating any retention number; a template default does not prove what is deployed. Analytics counters have a 400-day TTL and Fotomoto references expire after 30 days; the services can take additional time to remove expired items. Recheck those values when the infrastructure changes.

## Case record fields (private storage only)

Case number; received date; jurisdiction and deadline; verified contact or authority; requested scope; affected systems and specific identifiers; actions and confirmations; categories kept and why; expiry or review dates; response to the requester; appeal status; closure date; backup-restoration suppression reference.
