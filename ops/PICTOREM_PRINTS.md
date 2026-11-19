# Pictorem print orders

Eligible photos have an **Order a Print** link in the viewer. The link
opens Pictorem in a new tab with the edited, full-resolution photo already
selected. Pictorem handles product selection, payment, production, shipping,
and order support. The buyer can use Pictorem’s checkout without an account on
the photography site.

## Account and photos

The [Pictorem Dynamic Link](https://www.pictorem.com/pro/i/dynamiclink.html) uses
the public PRO ID `HQ1RAJ10HOD`. It is configured in
[`src/utils/printOrders.js`](../src/utils/printOrders.js). If the account changes,
replace the ID there and test the handoff. There is no API credential,
checkout integration, per-photo product listing, or per-order file upload to
maintain. Product and size availability come from Pictorem’s configurator.

Public photos use the full-resolution `downloadUrl` from the public gallery API.
Protected photo viewers request the same edited source as **Download** through
the existing download endpoint with `purpose: "print"`. The request runs only
on click. The endpoint rechecks account or share-code access, validates the
selected photo, and issues a five-minute S3 presigned GET for that single JPEG
or PNG. A revoked code cannot obtain a new print link. Already issued links
remain usable until they expire.

The browser opens Pictorem without passing the gallery as the referrer. Pictorem
receives the file URL and PRO ID. It can fetch the photo and any embedded
metadata before checkout. The source is the full-resolution edited upload
even when the viewer shows a camera-original comparison. See the site’s
[Privacy Notice](https://iantruongphotography.com/privacy).

For existing orders, use [Pictorem support](https://www.pictorem.com/contact.html),
[order tracking](https://www.pictorem.com/trackmyorder.html), and its
[sales terms](https://www.pictorem.com/terms.html). Direct privacy requests about
Pictorem-held information to the contact in its
[privacy policy](https://www.pictorem.com/privacy.html).

## Cutover

- Release the frontend and backend together using [the release workflow](CI_CD.md).
  Verify one gallery photo and one Explore photo in a signed-out browser. The
  tab should show the same photo in Pictorem without an upload prompt. Also
  test one private owner session and one share-code gallery with a test photo.
  Confirm the button requests the URL only on click and a revoked share code
  fails to create a new print link.
- The backend release retires the Fotomoto Lambda, its role and permissions, and
  its API routes. The change-set gate allows only these exact removals and
  requires CloudFormation to retain `PrintSessionSecret`. The old reference
  objects are covered by the existing 30-day S3 lifecycle rule.
- The frontend publishes [`public/print.html`](../public/print.html) over the
  historical print launcher. It provides a way back to the gallery and the
  print policy even if an old bookmark is used.
- After checking the new frontend, review the existing Route 53 records for
  `prints.iantruongphotography.com`. If present, remove the print records and
  wait for the DNS change and prior TTL to pass before removing the CloudFront
  alias. Use the [CloudFront migration workflow](README.md#frontend-and-dns)
  with the deployed API and private media flags. The render step drops the
  dedicated print cache behavior and legacy alias. After the distribution
  deploys, confirm both the current CSP and the legacy page, then retire the
  unassociated print response headers policy if present. The normal frontend
  and media distribution certificates and aliases stay in service.
