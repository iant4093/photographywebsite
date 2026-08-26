# Fotomoto print ordering

Photo lightboxes can open Fotomoto for public, link-only, and assigned private
albums. The integration deliberately runs on
`https://prints.iantruongphotography.com/print.html`, a separate browser-storage
origin. The Fotomoto script is never loaded by the authenticated application.

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
5. The API copies only that photograph's JPEG preview to an opaque public
   `fotomoto/references/` name. The full-resolution JPEG is copied to the
   matching private `fotomoto/originals/` name.
6. Fotomoto receives the opaque preview URL. Auto Pickup can read only the
   private originals prefix through a dedicated read-only IAM user. It cannot
   list or read albums, previews, backups, or any other bucket content.

Reference copies expire after 30 days and high-resolution pickup copies expire
after 7 days. A later click recreates either deterministic object. Revoking an
album, share, or user blocks new capabilities immediately; an already redeemed
opaque reference remains until its lifecycle expiry.

Fotomoto's legacy widget requires inline script handlers and dynamic JavaScript
evaluation. Those CSP allowances exist only on `print.html`; that page has no
authentication state, clears storage, accepts no user-rendered HTML, uses a
five-minute opaque fragment, and is marked noindex/no-referrer.

## One-time Fotomoto configuration

Store ID: `f3b4ffed02e8ae181e8de27d1b75195593fbcd49`

1. Sign in at <https://my.fotomoto.com/> and open the store at
   <https://my.fotomoto.com/store/f3b4ffed02e8ae181e8de27d1b75195593fbcd49>.
2. Open [**Store Settings**](https://my.fotomoto.com/stores/settings), find **Site Addresses**, click **Add Alternate
   Address**, and add `https://prints.iantruongphotography.com`.
   Fotomoto's current instructions are at
   <https://support.fotomoto.com/hc/en-us/articles/41749556027283-How-do-I-add-an-alternate-site-address>.
3. In the Dashboard **Settings** tab, find the **Image URL Whitelist**, click
   **(+) Add Alternate Address**, and allow only:

   `https://d1twwtwfz1yeo4.cloudfront.net/fotomoto/references/`

   Do not whitelist `/albums/`, the whole media domain, S3, or either website
   host. Instructions:
   <https://support.fotomoto.com/hc/en-us/articles/41880887507091-How-to-use-the-Image-URL-Whitelist>.
4. Configure the products, sizes, crop behavior, prices, shipping, tax, and
   Stripe payment settings that should appear in the print window. Leave file
   downloads and licensing disabled unless they are intentionally sold.
5. Enable **automatic order fulfillment** so successfully paid orders go to
   production without manual approval. Fotomoto's payment/fulfillment checklist
   is at
   <https://support.fotomoto.com/hc/en-us/articles/41739217927827-How-to-register-a-Fotomoto-account-created-via-the-Fotomoto-Partner-Program>.

## One-time Auto Pickup configuration

Auto Pickup is the maintenance-free path for full-resolution print files and
requires a Fotomoto plan that includes it. Follow
<https://support.fotomoto.com/hc/en-us/articles/41739456328595-Using-Auto-Pickup-to-find-your-print-files-automatically>.

After the backend stack has deployed, create exactly one access key. In the
Fotomoto Dashboard, open **Settings → Auto Pickup → Create New Profile** first,
then run:

```bash
aws iam create-access-key \
  --user-name ian-photography-fotomoto-autopickup-prod
```

The secret access key is displayed only once. Enter it directly into Fotomoto;
do not put it in `.env`, GitHub, source control, screenshots, notes, or AWS
Secrets Manager. Configure the Auto Pickup source as:

- Type: **Amazon S3**
- Region: **US West (Oregon) / `us-west-2`**
- Bucket: **`goldenhour-images-428207759706-prod`**
- Folder/prefix: **`fotomoto/originals/`**
- Lookup Pattern Helper: enter a staged website filename such as
  **`OPAQUE_STEM_web.jpg`** and its corresponding print filename
  **`OPAQUE_STEM_print.jpg`**, then save the exact pattern produced by the
  helper. The only transformation is replacing the final `_web.jpg` with
  `_print.jpg`; the opaque stem is unchanged.
- Access key / secret: the dedicated user's newly created key only

Click **Test Connection**, then **Save Profile**. Do not grant Fotomoto access
to the bucket root or `albums/`. To verify pickup without placing an order,
open **Store → All Photos Album**, hover the staged test image, click its
information (`i`) icon, then click the orange **Check** button. Fotomoto should
report that the print file was found. Finish with a low-value private test order
and cancel/refund it according to Fotomoto's workflow if appropriate.

## Routine operation and recovery

There is no scheduled application job and no catalog backfill. A print is
staged only after an authorized user clicks **Order a Print**. Normal uploads,
visibility changes, share revocation, and album deletion need no Fotomoto work.

If Auto Pickup reports a missing file, have the authorized user reopen the
photo and click **Order a Print** once to recreate the seven-day original, then
retry fulfillment. If the access key is ever exposed, create a second key,
replace it in Fotomoto, verify one pickup, and delete the old key. Never keep two
keys after the rotation test.

The Fotomoto API-mode and function references used by the implementation are:

- <https://support.fotomoto.com/hc/en-us/articles/41750590989971-Getting-Started-with-the-Fotomoto-API>
- <https://support.fotomoto.com/hc/en-us/articles/41750603193107-Fotomoto-API-Function-reference-page>
- <https://support.fotomoto.com/hc/en-us/articles/41750547895059-How-to-make-sure-the-Fotomoto-script-is-loaded>
