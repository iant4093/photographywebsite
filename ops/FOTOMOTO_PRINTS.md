# Fotomoto Free-plan print ordering

Photo lightboxes can open Fotomoto for public, link-only, and assigned private
albums. The integration runs only on
`https://prints.iantruongphotography.com/print.html`, a separate browser-storage
origin. The Fotomoto script is never loaded by the authenticated application.

The store uses Fotomoto's **Free** subscription. There is no monthly subscription
or Auto Pickup credential. A print-ready file is uploaded manually only after a
customer places an order.

## Security and data flow

1. The lightbox opens an empty window during the user's click and asks the API
   for a five-minute capability scoped to one album and one photograph.
2. The API authorizes the current public, Cognito-owner/admin, or exact active
   share-code access before issuing the capability. It contains no S3 path,
   user identity, album title, or share code.
3. The isolated page removes the capability from browser history and clears its
   own local/session storage before loading any third-party script.
4. Redemption rechecks that the album is active, its visibility has not
   changed, the share grant is still active when applicable, and the exact
   photograph still exists.
5. The API copies only that photograph's optimized JPEG preview to an opaque
   public `fotomoto/references/` name. It never copies, publishes, signs, or
   exposes the print-resolution original.
6. Fotomoto receives the opaque preview URL and handles product selection,
   checkout, payment, order records, production, and shipping.
7. After a paid order, the photographer identifies the image from Fotomoto's
   order preview and manually uploads the matching print-ready JPEG directly to
   that order in the Fotomoto Dashboard.

Reference copies expire after 30 days. A later authorized click recreates the
same deterministic reference. Revoking an album, share, or user blocks new
capabilities immediately; an already redeemed opaque reference remains until
its lifecycle expiry. Fotomoto receives neither an AWS credential nor access to
the media bucket.

Fotomoto's legacy widget requires inline script handlers and dynamic JavaScript
evaluation. Those CSP allowances exist only on `print.html`; that page has no
authentication state, clears storage, accepts no user-rendered HTML, uses a
five-minute opaque fragment, and is marked noindex/no-referrer.

## One-time Fotomoto configuration

Store ID: `f3b4ffed02e8ae181e8de27d1b75195593fbcd49`

1. Sign in at <https://my.fotomoto.com/> and open the store at
   <https://my.fotomoto.com/store/f3b4ffed02e8ae181e8de27d1b75195593fbcd49>.
2. In the signup/subscription settings, select **Free** (`$0/month`). Current
   plan details are at <https://www.fotomoto.com/home/pricing>. The Free plan
   charges a transaction fee on sales and does not include Auto Pickup or
   framed prints.
3. Connect the existing **Stripe** account for customer payments. Add the card
   or PayPal source Fotomoto will charge for the lab's production and shipping
   cost. Fotomoto's registration and payment checklist is at
   <https://support.fotomoto.com/hc/en-us/articles/41739217927827-How-to-register-a-Fotomoto-account-created-via-the-Fotomoto-Partner-Program>.
4. In **Order Processing**, choose **Automatic** so that, after the requested
   high-resolution file has been supplied, Fotomoto's lab prints, packages, and
   ships the order instead of asking the photographer to self-fulfill it.
5. Open [**Store Settings**](https://my.fotomoto.com/stores/settings), find
   **Site Addresses**, choose **Add Alternate Address**, and add exactly:

   `https://prints.iantruongphotography.com`

   Fotomoto's address instructions are at
   <https://support.fotomoto.com/hc/en-us/articles/41749556027283-How-do-I-add-an-alternate-site-address>.
6. In the Dashboard **Settings** tab, find **Image URL Whitelist**, choose
   **(+) Add Alternate Address**, and allow only:

   `https://d1twwtwfz1yeo4.cloudfront.net/fotomoto/references/`

   Do not whitelist `/albums/`, the whole media domain, S3, or either website
   host. Instructions are at
   <https://support.fotomoto.com/hc/en-us/articles/41880887507091-How-to-use-the-Image-URL-Whitelist>.
7. In **Store → For Sale**, enable only the products and sizes that should be
   offered, set selling prices, and confirm crop behavior. Leave downloads and
   licensing disabled unless they are intentionally sold. Free supports the
   print products listed at
   <https://support.fotomoto.com/hc/en-us/articles/41714161921171-Products-you-can-sell-using-Fotomoto>,
   except framed prints, which require Pro or Pro Plus.
8. Do **not** create an Auto Pickup profile and do not create or enter an AWS
   access key. The Free-plan integration has no vendor IAM identity.

## Order workflow

Customer flow:

1. Open a photo lightbox and choose **Order a Print**.
2. Choose an enabled product, size, crop, quantity, and shipping option in the
   Fotomoto window.
3. Complete payment through Fotomoto's Stripe checkout.
4. Receive Fotomoto's order confirmation and shipment updates. The customer
   never needs an account on the photography website.

Photographer flow after an order:

1. Open the order-notification email or sign in at <https://my.fotomoto.com/>.
2. Open the pending order and use its visible preview to identify the exact
   photograph. The opaque website filename is not intended to identify the
   private album or original path.
3. Export or locate the matching full-resolution, print-ready JPEG. Use the
   original color space and dimensions Fotomoto requests; do not upscale the
   website preview.
4. Upload that JPEG through the order's high-resolution upload prompt. Fotomoto
   documents the manual path as the normal alternative to Auto Pickup in its
   product tour: <https://www.fotomoto.com/home/tour>.
5. Confirm the upload and order status. With automatic lab fulfillment enabled,
   Fotomoto handles production, packaging, shipping, and customer updates from
   that point.

There is no scheduled application job, catalog backfill, credential rotation,
or ongoing gallery synchronization. Normal uploads, visibility changes, share
revocation, and album deletion require no Fotomoto maintenance. The only manual
work is supplying a print-ready JPEG when a real order is received.

The Fotomoto API-mode and widget references used by the implementation are:

- <https://support.fotomoto.com/hc/en-us/articles/41750590989971-Getting-Started-with-the-Fotomoto-API>
- <https://support.fotomoto.com/hc/en-us/articles/41750603193107-Fotomoto-API-Function-reference-page>
- <https://support.fotomoto.com/hc/en-us/articles/41750547895059-How-to-make-sure-the-Fotomoto-script-is-loaded>
