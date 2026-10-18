# Fotomoto Free-plan print ordering

From a photo lightbox, people can open Fotomoto in a print dialog on the page.
It works for public, link-only and assigned private albums. The integration
only runs on `https://prints.iantruongphotography.com/print.html`, which is a
separate origin with its own browser storage. The main signed-in app never
loads the Fotomoto script. It only frames that one isolated origin. Closing the
dialog takes you back to the same photo and scroll position.

I built this around Fotomoto's Free subscription, with me delivering the
print-ready file by hand after each order. I haven't confirmed the actual
subscription and payment settings yet: the dashboard asked me to log in when I
checked on September 17, 2026. So the fact that this integration exists doesn't
mean the store is ready to take paid orders.

## How an order request flows

1. **Order a Print** asks the API for a five-minute capability that covers one
   album and one photo. It then opens a dialog on the page that frames
   `print.html` on the isolated origin, with the capability in the URL
   fragment.
2. Before issuing the capability, the API checks the viewer's access: public,
   Cognito owner/admin, or a currently active share code. The capability holds
   no S3 path, user identity, album title or share code.
3. The isolated page strips the capability from browser history and clears its
   own local and session storage before it loads any third-party script.
4. When the capability is redeemed, the API checks again that the album is
   active, its visibility hasn't changed, the share grant is still active (if
   there is one), and the photo still exists.
5. The API copies only that photo's optimized JPEG preview to an opaque public
   name under `fotomoto/references/`. It never copies, publishes, signs or
   exposes the print-resolution original.
6. Fotomoto gets the opaque preview URL and handles product choice, checkout,
   payment, order records, production and shipping.
7. After a paid order, I find the image from Fotomoto's order preview and
   upload the matching print-ready JPEG straight to that order in the Fotomoto
   Dashboard.

Reference copies expire after 30 days. A later authorized click recreates the
same deterministic reference. Revoking an album, share or user stops new
capabilities right away, but a reference that was already redeemed stays until
its lifecycle expiry. Fotomoto never gets an AWS credential or access to the
media bucket.

Fotomoto's legacy widget needs inline script handlers and dynamic JavaScript
evaluation. I only allow those in the CSP for `print.html`. That page has no
sign-in state, clears storage, accepts no user-rendered HTML, uses a
five-minute opaque fragment, and is marked noindex/no-referrer.

## One-time Fotomoto setup

Store ID: `f3b4ffed02e8ae181e8de27d1b75195593fbcd49`

1. Sign in at <https://my.fotomoto.com/> and open the store at
   <https://my.fotomoto.com/store/f3b4ffed02e8ae181e8de27d1b75195593fbcd49>.
2. In the signup/subscription settings, pick **Free** (`$0/month`). Current plan
   details are at <https://www.fotomoto.com/home/pricing>. The Free plan takes
   22% of each sale plus payment-processor fees, and it doesn't include Auto
   Pickup or framed prints. I checked these rates on September 17, 2026, so
   check again before choosing a plan. Production and shipping costs also have
   to be covered.
3. Connect a **Stripe or PayPal** account for customer payments. The owner has
   to do account creation, identity verification and financial setup. Add the
   card or PayPal source that Fotomoto will charge for the lab's production and
   shipping cost. Fotomoto's registration and payment checklist is at
   <https://support.fotomoto.com/hc/en-us/articles/41739217927827-How-to-register-a-Fotomoto-account-created-via-the-Fotomoto-Partner-Program>.
4. In **Order Processing**, choose **Automatic**. That way, once the
   high-resolution file is in, Fotomoto's lab prints, packs and ships the order
   instead of asking me to fulfill it myself.
5. Open [**Store Settings**](https://my.fotomoto.com/stores/settings), find
   **Site Addresses**, choose **Add Alternate Address**, and add this address
   as written:

   `https://prints.iantruongphotography.com`

   Fotomoto's instructions for this are at
   <https://support.fotomoto.com/hc/en-us/articles/41749556027283-How-do-I-add-an-alternate-site-address>.
6. In the Dashboard **Settings** tab, find **Image URL Whitelist**, choose
   **(+) Add Alternate Address**, and allow only:

   `https://d1twwtwfz1yeo4.cloudfront.net/fotomoto/references/`

   Don't whitelist `/albums/`, the whole media domain, S3, or either website
   host. Instructions are at
   <https://support.fotomoto.com/hc/en-us/articles/41880887507091-How-to-use-the-Image-URL-Whitelist>.
7. In **Store → For Sale**, turn on only the products and sizes you want to
   offer, set selling prices, and check how cropping behaves. Leave downloads
   and licensing off unless you actually mean to sell them. Free supports the
   print products listed at
   <https://support.fotomoto.com/hc/en-us/articles/41714161921171-Products-you-can-sell-using-Fotomoto>,
   except framed prints, which need Pro or Pro Plus.
8. Don't create an Auto Pickup profile, and don't create or enter an AWS access
   key. The Free-plan integration has no vendor IAM identity.

## Handling an order

What the customer does:

1. Open a photo lightbox and choose **Order a Print**. The print dialog opens
   over the photo without a new browser tab or pop-up.
2. Pick an enabled product, size, crop, quantity and shipping option in the
   Fotomoto panel. If they close the vendor panel, **Reopen print options**
   brings it back. Closing the website dialog returns to the photo.
3. Pay with whatever options Fotomoto checkout offers.
4. Get Fotomoto's order confirmation and shipping updates. They never need an
   account on the photography site.

What I do after an order:

1. Open the order-notification email or sign in at <https://my.fotomoto.com/>.
2. Open the pending order and use its preview to identify the photo. The
   opaque filename on the website isn't meant to reveal the private album or
   original path.
3. Export or find the matching full-resolution, print-ready JPEG. Use the
   original color space and the dimensions Fotomoto asks for. Don't upscale the
   website preview.
4. Upload that JPEG through the order's high-resolution upload prompt.
   Fotomoto's product tour describes this manual path as the normal alternative
   to Auto Pickup: <https://www.fotomoto.com/home/tour>.
5. Check that the upload went through and look at the order status. With
   automatic lab fulfillment on, Fotomoto takes care of production, packing,
   shipping and customer updates from there.

There's no scheduled job, catalog backfill, credential rotation or ongoing
gallery sync. Normal uploads, visibility changes, share revocation and album
deletion need no Fotomoto upkeep. The only manual file work is supplying a
print-ready JPEG when a real order comes in. I still have to keep an eye on
orders, delivery deadlines, customer service and refunds. None of that is
automated.

These are the Fotomoto API-mode and widget references the implementation
follows:

- <https://support.fotomoto.com/hc/en-us/articles/41750590989971-Getting-Started-with-the-Fotomoto-API>
- <https://support.fotomoto.com/hc/en-us/articles/41750603193107-Fotomoto-API-Function-reference-page>
- <https://support.fotomoto.com/hc/en-us/articles/41750547895059-How-to-make-sure-the-Fotomoto-script-is-loaded>

## Seller responsibilities and launch review (September 17, 2026)

The seller should show as Ian Truong, an individual in Oregon, with
iant4093@gmail.com for order support. Check those in the dashboard, along with
enabled products, selling prices, shipping destinations, payment receipt,
lab-cost billing and tax settings. Product costs and profit math have to be
checked inside the real dashboard. I didn't verify them here. Nobody should
pick a paid plan, open a financial account or accept vendor agreements on the
owner's behalf without proper authorization.

Fotomoto offers automatic lab fulfillment, but with this integration I still
have to deliver the original print-ready file by hand, so watch for new order
notifications. Fotomoto says production can take up to seven business days
after they get the files, plus shipping time. That's their estimate, not a new
delivery promise from me. Honor the estimate on the actual order and any
required delay or refund rules.
[Production and shipping](https://support.fotomoto.com/hc/en-us/articles/41714911153043-How-long-should-it-take-to-receive-my-order)

Under Fotomoto's newer support policy, refund requests are the seller's job.
Their older marketing page mentions 30 days, which conflicts with that. Before
opening sales, make sure any return promise shown at checkout lines up with
`/print-policy`. If an order was sold with a better promise, that promise has
to be honored. The site looks at voluntary returns case by case and keeps any
remedies the law requires.
[Refund policy](https://support.fotomoto.com/hc/en-us/articles/41715076303379-Fotomoto-Refund-Policy)

Fotomoto's terms require the right content permissions, including releases for
recognizable people or property as their contract spells out. The owner
confirming permission to post doesn't cover every release or right Fotomoto
needs for every commercial use, and shooting in a public place isn't a
substitute. Read the terms before putting affected images up for sale. I
haven't created any release documents or client contracts.
[Fotomoto terms](https://www.fotomoto.com/help/terms)

Tax collection depends on how it's configured and on what's actually owed. Being
in Oregon doesn't settle what's owed anywhere else. Import duties can be charged
at the destination, separately from checkout. Don't promise that Fotomoto takes
care of every tax obligation automatically.
[Payments and tax settings](https://support.fotomoto.com/hc/en-us/articles/41713497061907-How-can-I-get-paid-for-the-products-I-sell-using-Fotomoto),
[International import charges](https://support.fotomoto.com/hc/en-us/articles/41749634252307-Are-taxes-and-custom-fees-on-items-shipped-internationally-added-to-orders)
