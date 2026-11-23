import { Link } from 'react-router'
import './Explore.css'
import './Apps.css'

const randomEndpoint = 'https://photos-api.iantruongphotography.com/v1/photos/random'
const listEndpoint = 'https://photos-api.iantruongphotography.com/v1/photos'
const randomExamples = [
    ['', 'Pick from all public photos.'],
    ['?featured=true', 'Pick from all featured public photos.'],
    ['?album=your-album-slug', 'Pick from one public album.'],
    ['?album=your-album-slug&featured=true', 'Prefer featured photos in that album. If it has none, pick from all its photos.'],
]
const listExamples = [
    ['', 'List all public photos (up to 200 per page).'],
    ['?featured=true', 'List all featured public photos.'],
    ['?album=your-album-slug', 'List all photos in one public album.'],
    ['?album=your-album-slug&featured=true', 'List featured photos in that album, or fall back to all its photos if it has none.'],
    ['?featured=true&cursor=1', 'Fetch the next page using the nextCursor value from the previous response.'],
]

export default function PhotoApi() {
    return (
        <div className="explore-page apps-page animate-fade-in pt-[74px]">
            <article className="app-api-reference mx-auto max-w-3xl px-6 pt-14 pb-20 md:pt-20 md:pb-28">
                <Link to="/apps" state={{ restoreScroll: '/apps' }} className="explore-back">← All apps</Link>
                <header className="linen-section-heading mt-8">
                    <span>Developer tools</span>
                    <h1 className="font-serif text-4xl md:text-6xl font-normal text-charcoal">Photo API</h1>
                    <p>Get a random photo or a paginated list of photos from the public galleries, each with a link to its full-resolution image.</p>
                </header>

                <section className="mt-10" aria-labelledby="photo-api-start">
                    <h2 id="photo-api-start" className="font-serif text-3xl text-charcoal">Quick start</h2>
                    <p>Send a GET request. Both endpoints are public and work without an API key.</p>
                    <pre><code>{`curl -fsS '${randomEndpoint}'\ncurl -fsS '${listEndpoint}?featured=true'`}</code></pre>
                    <p>
                        <a href={randomEndpoint}>Open the endpoint ↗</a>
                        {' · '}
                        <a href={listEndpoint}>Open the list endpoint ↗</a>
                    </p>
                </section>

                <section className="mt-10" aria-labelledby="photo-api-parameters">
                    <h2 id="photo-api-parameters" className="font-serif text-3xl text-charcoal">Choose a pool</h2>
                    <p>Both parameters are optional. Use the slug from the public album URL, after <code>/album/</code>. Set <code>featured=true</code> to request featured photos. The default, <code>featured=false</code>, includes every eligible photo.</p>
                    <dl className="app-api-examples">
                        {randomExamples.map(([query, description]) => (
                            <div key={`random${query}`}>
                                <dt><code>{`/v1/photos/random${query}`}</code></dt>
                                <dd>{description}</dd>
                            </div>
                        ))}
                    </dl>
                </section>

                <section className="mt-10" aria-labelledby="photo-api-list">
                    <h2 id="photo-api-list" className="font-serif text-3xl text-charcoal">List a pool without repeats</h2>
                    <p>Use <code>/v1/photos</code> when you want the full set of photos in a pool—for example, to shuffle locally and show every photo once before looping. It accepts the same <code>album</code> and <code>featured</code> filters plus an optional zero-based <code>cursor</code> parameter.</p>
                    <dl className="app-api-examples">
                        {listExamples.map(([query, description]) => (
                            <div key={`list${query}`}>
                                <dt><code>{`/v1/photos${query}`}</code></dt>
                                <dd>{description}</dd>
                            </div>
                        ))}
                    </dl>
                </section>

                <section className="mt-10" aria-labelledby="photo-api-response">
                    <h2 id="photo-api-response" className="font-serif text-3xl text-charcoal">Read the response</h2>
                    <p>Use <code>imageUrl</code> to download the full-resolution file. Each photo includes <code>id</code>, <code>albumSlug</code>, <code>albumUrl</code>, <code>width</code>, <code>height</code>, and <code>bytes</code>. <code>featured</code> describes the selected photo, and <code>fallbackUsed</code> tells you whether an album request fell back to all its photos.</p>
                    <p><code>/v1/photos/random</code> returns one photo object and draws again on every request, so a photo can repeat. <code>/v1/photos</code> returns <code>{`{ items, fallbackUsed, nextCursor }`}</code> with up to 200 photo objects per page; pass <code>nextCursor</code> as <code>cursor</code> until it is <code>null</code>.</p>
                    <p>Downloads can be large. Use <code>bytes</code> to check the size first and reuse the downloaded file when you need the same photo again.</p>
                </section>

                <section className="mt-10" aria-labelledby="photo-api-errors">
                    <h2 id="photo-api-errors" className="font-serif text-3xl text-charcoal">Errors and limits</h2>
                    <p><code>400</code> means a query parameter or <code>cursor</code> is invalid or out of range. <code>404</code> means the requested pool has no eligible photos. Slow down if you receive <code>403</code> or <code>429</code> during repeated requests. If the service returns <code>503</code>, wait before trying again.</p>
                </section>
            </article>
        </div>
    )
}
