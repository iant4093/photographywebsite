# Privacy requests and retention

Owner: Ian Truong, Oregon. Public contact: iant4093@gmail.com. Adopted September 12, 2026.

The privacy notice promises that a person (me) reviews every request. The album and account delete buttons on the site don't erase every backup or vendor record, so I never tell someone their data is fully erased just because I clicked one. This process also isn't a license to delete unrelated media, or to keep everything forever.

## Taking a request and replying

1. Watch the published email address and the contact-form inbox. In a private case file, record the date received, request type, requester contact, an opaque case number and the response deadline. Real case files, identities, account tokens, gallery links and evidence never go in this repository.
2. Work out what they're asking for: access or a copy, correction, gallery removal, erasure, objection or opt-out, a concern about a photograph, or an appeal. If it's unclear, ask, but don't make them start over.
3. Verify in proportion to the request, using the account or contact relationship we already have. Confirm an agent's authority when it matters. Don't ask for passwords or ID documents by default, and never show someone else's gallery while verifying. A simple request to stop optional tracking doesn't need an account or ID.
4. Figure out the deadline. For covered Oregon requests it's 45 days, and I can take another 45 if I justify it and tell the person in time. Appeals get a written decision within 45 days. Other places have their own deadlines, so don't assume Oregon's apply everywhere. Internally I aim for 7 days to acknowledge and 30 days for a real answer, which leaves room to sort out problems. Those targets are mine; the law doesn't require them. [Oregon DOJ consumer FAQ](https://www.doj.state.or.us/consumer-protection/id-theft-data-breaches/privacy/privacy-law-faqs-for-consumers/)
5. For an appeal, the person can reply to the original decision or send an email headed “Privacy appeal.” Look at the reasons again and write down the outcome. If I turn down an Oregon appeal, include the Oregon DOJ complaint information linked in that FAQ.

## Find everything before deleting anything

Before deleting gallery or account records, build a private inventory so I still have the mapping to backups when I need it later in the request. Use the account subject, album ID, media IDs, verified Drive folder and file IDs, and order numbers. Never match or delete by someone's name alone, since names collide.

| System | What to check and do |
| --- | --- |
| Cognito and album/media records | Find accounts, owner assignments, every gallery they own, and the individual photographs involved. Check access and share grants. Also check Recently Deleted: the Delete button in Manage Albums only hides an album there for 30 days, so use "Delete permanently" on that page (account deletion already covers a client's binned albums). |
| S3 and media delivery | Find originals, thumbnails, previews, original-comparison derivatives, ZIPs, every object version and any cached copies. Use the existing version-aware deletion and invalidation procedures, and check that public copies stop resolving. Deleting an album or media also removes its generated comparison previews; older orphans need `ops/sweep_comparison_previews.py` ([MAINTENANCE_AND_RECOVERY.md](MAINTENANCE_AND_RECOVERY.md#generated-original-comparison-cleanup)). |
| Google Drive backups | Deleting a whole album leaves this folder in place. Record the verified root ancestry and IDs first. Tell synced backup copies apart from unrelated files, manual extras and archives. Remove the copies that apply as a separate step, and look in Trash and old versions too. |
| Original-comparison archives | Check these separately from the website backup root. Normal gallery-sync deletion doesn't touch them on purpose. Decide whether keeping the originals is necessary and legally allowed. |
| Fotomoto references | Print redemption creates opaque preview copies. Their normal lifecycle is roughly 30 days plus the provider's cleanup. For an urgent deletion, safely identify the specific reference and arrange removal; revoking the gallery isn't enough on its own. |
| Fotomoto/Bay Photo and Stripe | Find the orders and print-ready uploads. Ask for deletion or correction where it applies, and separate fulfillment copies from records the vendor has to keep. Record confirmations and exceptions. Never email card details. |
| Gmail and Resend | Find the inquiry, correspondence, sent copies, delivery records and Trash. Keep only what a documented exception needs. |
| Logs and recovery backups | Check the retention that's actually configured, who can access it, and any incident or legal holds. Where allowed, let protected backups expire, and keep a minimal suppression record so a restore doesn't bring deleted information back. |

When a photo has several people in it, check the scope and the other people's rights before removing a whole shared album. Asking for a photo to come down isn't the same as asking me to delete the photographer's account, all the original photos, or every record of a sale.

## Doing it and checking it worked

Use the existing authenticated admin tools or maintenance procedures, and only for the scope that was approved. Check for failures, retries, caches and provider responses. Keep a minimal private suppression record in case a backup is ever restored. Private records never get copied into public legal pages, build artifacts or the source repository.

For each category I keep, write down the specific reason, who can access it, and the next review or expiry date. "A backup exists" isn't a legal exception by itself. Tell the requester what copies remain, when they'll expire, and what the exceptions are, without giving away security-sensitive details about the system. Send access-request responses through a suitable private channel.

Close a case only after the applicable actions are done, or after explaining any lawful refusal or partial completion. Keep only the minimum case evidence needed for accountability and disputes, and review it for deletion when it's no longer needed. Real retention periods have to come from accounting, legal and business needs. Don't make up one number for everything.

## Routine retention review

Every so often, go through old inquiry threads, unused client accounts, expired delivery galleries, backups and archives, and closed cases. Record the decisions privately. Check the live log settings before promising any number; a template default doesn't prove what's deployed. The analytics counter TTL is 400 days and the Fotomoto reference lifecycle is 30 days, and the services can take a while to clean up after that. Recheck those values when the infrastructure changes.

## Case record fields (private storage only)

Case number; received date; jurisdiction and deadline; verified contact or authority; requested scope; affected systems and specific identifiers; actions and confirmations; categories kept and why; expiry or review dates; response to the requester; appeal status; closure date; backup-restoration suppression reference.
