# Fotomoto Free-plan print ordering

From a photo lightbox, **Order a Print** opens Fotomoto in a dialog on the
page. It is available for photos in public, link-only (share code) and private
albums the viewer can access as owner or admin. Video albums are excluded. The
integration runs only on `https://prints.iantruongphotography.com/print.html`,
a separate origin with its own browser storage. The main app never loads the
Fotomoto script; it only frames that origin. Closing the dialog returns focus
to the same photo.

The integration is built for Fotomoto's Free plan: Fotomoto has no access to
the print-resolution files, and the print-ready file is uploaded by hand after
each order. The subscription, payment and store settings live in the Fotomoto
dashboard and cannot be verified from this repository. Complete and confirm
the setup below before taking paid orders.

## How an order request flows

1. The **Order a Print** button asks the API (`POST /albums/{albumId}/print` or
   `POST /shared/{shareCode}/print`) for a five-minute capability that covers
   one album and one photo. The app then opens a dialog that frames
   `print.html` on the print origin, with the capability in the URL fragment.
2. Before issuing the capability, the API checks the viewer's access: public,
   Cognito owner/admin, or an active share code. The capability holds no S3
   path, user identity or album title. For share access it holds a truncated
   SHA-256 of the share code, not the code itself.
3. The print page clears its own local and session storage and removes the
   capability from the address bar and history before it loads any
   third-party script.
4. When the capability is redeemed (`POST /print/session`), the API checks
   again that the album is active, its visibility has not changed, the share is
   still active with the same code (for share access), and the photo still
   exists.
5. The API copies only that photo's JPEG thumbnail (`thumbKey`) to an opaque
   public name under `fotomoto/references/`. It never copies, publishes or
   signs the print-resolution original.
6. Fotomoto receives the opaque reference URL and handles product choice,
   checkout, payment, order records, production and shipping.
7. After a paid order, the seller identifies the image from Fotomoto's order
   preview and uploads the matching print-ready JPEG to that order in the
   Fotomoto dashboard.

Reference copies expire 30 days after creation through an S3 lifecycle rule. A
later authorized request recreates the same deterministic reference name.
Revoking an album, share or user stops new capabilities right away, but a
reference that was already created stays until its lifecycle expiry. Fotomoto
never receives an AWS credential or access to the media bucket.

Fotomoto's legacy widget needs inline scripts and dynamic JavaScript
evaluation. Only the print origin's `print.html` response headers policy adds
`'unsafe-inline'` and `'unsafe-eval'` to `script-src`. That page has no
sign-in state, clears storage, renders no user-supplied HTML, uses a
five-minute opaque fragment, and sets `noindex` and `no-referrer`.

## One-time Fotomoto setup

Store ID: `f3b4ffed02e8ae181e8de27d1b75195593fbcd49`

1. Sign in at <https://my.fotomoto.com/> and open the store at
   <https://my.fotomoto.com/store/f3b4ffed02e8ae181e8de27d1b75195593fbcd49>.
2. In the signup/subscription settings, select the **Free** plan. Review the
   current commission, payment-processor fees and plan limits at
   <https://www.fotomoto.com/home/pricing> before choosing. This integration
   does not use Auto Pickup or framed prints. Production and shipping costs
   also have to be covered.
3. Connect a Stripe or PayPal account for customer payments. Account creation,
   identity verification and financial setup must be done by the account
   owner. Add the card or PayPal source that Fotomoto charges for lab
   production and shipping. Fotomoto's registration and payment checklist is at
   <https://support.fotomoto.com/hc/en-us/articles/41739217927827-How-to-register-a-Fotomoto-account-created-via-the-Fotomoto-Partner-Program>.
4. In **Order Processing**, select **Automatic**, so that once the
   high-resolution file is uploaded, Fotomoto's lab prints, packs and ships the
   order.
5. Open [Store Settings](https://my.fotomoto.com/stores/settings), find
   **Site Addresses**, choose **Add Alternate Address**, and add this address
   as written:

   `https://prints.iantruongphotography.com`

   Fotomoto's instructions are at
   <https://support.fotomoto.com/hc/en-us/articles/41749556027283-How-do-I-add-an-alternate-site-address>.
6. In the dashboard **Settings** tab, find **Image URL Whitelist**, choose
   **(+) Add Alternate Address**, and allow only:

   `https://d1twwtwfz1yeo4.cloudfront.net/fotomoto/references/`

   Do not whitelist `/albums/`, the whole media domain, S3, or either website
   host. Instructions are at
   <https://support.fotomoto.com/hc/en-us/articles/41880887507091-How-to-use-the-Image-URL-Whitelist>.
7. In **Store → For Sale**, enable only the products and sizes to offer, set
   selling prices, and check cropping behavior. Leave downloads and licensing
   off unless they are meant to be sold. The product list is at
   <https://support.fotomoto.com/hc/en-us/articles/41714161921171-Products-you-can-sell-using-Fotomoto>.
8. Do not create an Auto Pickup profile, and do not create or enter an AWS
   access key. The integration has no vendor IAM identity.

## Handling an order

Customer steps:

1. Open a photo lightbox and choose **Order a Print**. The print dialog opens
   over the photo without a new browser tab or pop-up.
2. Pick an enabled product, size, crop, quantity and shipping option in the
   Fotomoto panel. If the vendor panel is closed, **Reopen print options**
   brings it back. **Back to Photo** or Escape closes the website dialog.
3. Pay with the options Fotomoto checkout offers.
4. Receive Fotomoto's order confirmation and shipping updates. No account on
   the photography site is needed.

Seller steps after an order:

1. Open the order-notification email or sign in at <https://my.fotomoto.com/>.
2. Open the pending order and use its preview to identify the photo. The
   reference filename is opaque and does not reveal the album or original
   path.
3. Export or locate the matching full-resolution, print-ready JPEG. Use the
   original color space and the dimensions Fotomoto requests. Do not upscale
   the website reference image.
4. Upload that JPEG through the order's high-resolution upload prompt.
   Fotomoto's product tour describes this manual path as the alternative to
   Auto Pickup: <https://www.fotomoto.com/home/tour>.
5. Confirm the upload succeeded and check the order status. With automatic lab
   fulfillment enabled, Fotomoto handles production, packing, shipping and
   customer updates from there.

The integration has no scheduled job, catalog backfill, credential rotation or
gallery sync. Uploads, visibility changes, share revocation and album deletion
need no Fotomoto upkeep. The manual work is supplying a print-ready JPEG for
each order, plus monitoring orders, delivery deadlines, customer service and
refunds, none of which is automated.

Fotomoto API-mode and widget references used by the implementation:

- <https://support.fotomoto.com/hc/en-us/articles/41750590989971-Getting-Started-with-the-Fotomoto-API>
- <https://support.fotomoto.com/hc/en-us/articles/41750603193107-Fotomoto-API-Function-reference-page>
- <https://support.fotomoto.com/hc/en-us/articles/41750547895059-How-to-make-sure-the-Fotomoto-script-is-loaded>

## Seller responsibilities and launch review

The site's privacy and terms pages name the seller as Ian Truong, an
individual photographer based in Oregon, and the print page links
`iant4093@gmail.com` for order help. In the dashboard, set the seller details
to match, and review enabled products, selling prices, shipping destinations,
payment receipt, lab-cost billing and tax settings. Product costs and margins
can only be checked in the dashboard. Selecting a paid plan, opening a
financial account or accepting vendor agreements requires the account owner.

Fotomoto offers automatic lab fulfillment, but this integration still requires
the seller to upload the print-ready file by hand, so new order notifications
need monitoring. Fotomoto's support article gives its production and shipping
estimates; the site does not add its own delivery promise. Follow the estimate
shown on the actual order and any required delay or refund rules.
[Production and shipping](https://support.fotomoto.com/hc/en-us/articles/41714911153043-How-long-should-it-take-to-receive-my-order)

Fotomoto's refund policy article assigns refund requests to the seller.
Before opening sales, confirm that any return terms shown at checkout match
`/print-policy`. That page reviews change-of-mind returns case by case, honors
more favorable terms offered with an order, and keeps remedies required by
law.
[Refund policy](https://support.fotomoto.com/hc/en-us/articles/41715076303379-Fotomoto-Refund-Policy)

Fotomoto's terms require the seller to hold the necessary content rights,
including releases for recognizable people or property as the terms describe.
Permission to post a photo does not by itself cover every release or right
needed for commercial sale. Read the terms before offering affected images.
The repository contains no model or property release documents.
[Fotomoto terms](https://www.fotomoto.com/help/terms)

Tax collection depends on the store's configuration and on what is owed in
each destination. Import duties can be charged at the destination, separately
from checkout. Do not state that Fotomoto handles every tax obligation
automatically.
[Payments and tax settings](https://support.fotomoto.com/hc/en-us/articles/41713497061907-How-can-I-get-paid-for-the-products-I-sell-using-Fotomoto),
[International import charges](https://support.fotomoto.com/hc/en-us/articles/41749634252307-Are-taxes-and-custom-fees-on-items-shipped-internationally-added-to-orders)
