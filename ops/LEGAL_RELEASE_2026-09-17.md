# Legal release — September 17, 2026

The owner authorized publishing the completed legal changes. This release builds
on the upload-progress change at `1dda46c`; lightbox interaction work and the
separate README/architecture rewrite are excluded.

## Final owner choices and research

Photographs owned by Ian may be reused for any lawful purpose, including
commercial use, editing, distribution, and resale, without credit or a separate
permission request. Copyright ownership remains with Ian. The grant does not
supply other people's privacy/publicity rights or grant private account access.
The owner says the people he posts agree to publication. No signed releases or
client contracts are claimed or created.

Fotomoto's support refund article updated February 18, 2026 assigns refund
responsibility to the seller, in conflict with an older 30-day marketing page.
The revised print policy states seller responsibility, handles voluntary returns
individually, honors better terms offered with an order, and preserves legally
required remedies. Payment-provider wording is conditional on actual checkout.
See [the researched setup and order guide](FOTOMOTO_PRINTS.md).

The dashboard required login during review. Its plan, payment connection, billing
source, products, pricing, tax and fulfillment settings remain unverified.
Public research cannot establish these private account facts. No vendor account,
financial connection, paid order, or vendor agreement was created or changed.

## Performance budget adjustment

The release distributes matching LibRaw source and the required software notices
as separate downloads. `dist/licenses/` adds approximately 1.94 MB uncompressed /
1.73 MB gzip, including the already compressed source archive; none of these files
loads as part of the initial page. Total artifact limits increase from 9.4 to
11.4 MB uncompressed and 6.2 to 8.0 MB gzip to cover this deliberate distribution.
The initial JavaScript limit increases by 2 KB, from 356 to 358 KB, for four lazy
policy routes, document titles, and footer links. Entry gzip, CSS, largest-chunk,
and all backend budgets remain unchanged. The policy bodies remain lazy loaded.

## Release procedure

Local checks passed: 115 frontend files / 1,123 tests (91.18% statements,
83.93% branches), 639 backend tests (89.80% lines, 81.75% branches), and
422 infrastructure/ops tests (86.55% lines, 80.76% branches; two skipped).
Preview-worker coverage, actual native RAW decoding, infrastructure lint and
clean SAM build, all artifact budgets, workflow policy, and credential-history
checks also passed. The final terms and print policy were inspected in the
built site. Actual frontend artifact: 10,858,555 bytes total, 7,831,592 gzip;
357,217 bytes initial JavaScript, 115,522 gzip.
The exact committed release must also pass the normal production CI gate,
artifact attestation, guarded backend deployment, frontend deployment, and
public smoke test. Never bypass a failed guard with a direct production upload.

The [September 12 implementation record](LEGAL_IMPLEMENTATION_2026-09-12.md)
describes the feature tests and browser checks. Later release results are
reported in the task and the repository's production workflow run.
