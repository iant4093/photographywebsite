import { Link } from 'react-router'
import './Explore.css'
import './Apps.css'

const endpoint = 'https://photos-api.iantruongphotography.com/v1/photos/random'
const examples = [
    ['', 'Pick from all public photos.'],
    ['?featured=true', 'Pick from all featured public photos.'],
    ['?album=your-album-slug', 'Pick from one public album.'],
    ['?album=your-album-slug&featured=true', 'Prefer featured photos in that album. If it has none, pick from all its photos.'],
]

export default function PhotoApi() {
    return (
        <div className="explore-page apps-page animate-fade-in pt-[74px]">
            <article className="app-api-reference mx-auto max-w-3xl px-6 pt-14 pb-20 md:pt-20 md:pb-28">
                <Link to="/apps" state={{ restoreScroll: '/apps' }} className="explore-back">← All apps</Link>
                <header className="linen-section-heading mt-8">
                    <span>Developer tools</span>
                    <h1 className="font-serif text-4xl md:text-6xl font-normal text-charcoal">Photo API</h1>
                    <p>Get one random photo from the public galleries and a link to its full-resolution image.</p>
                </header>

                <section className="mt-10" aria-labelledby="photo-api-start">
                    <h2 id="photo-api-start" className="font-serif text-3xl text-charcoal">Quick start</h2>
                    <p>Send a GET request. The endpoint is public and works without an API key.</p>
                    <pre><code>{`curl -fsS '${endpoint}'`}</code></pre>
                    <p><a href={endpoint}>Open the endpoint ↗</a></p>
                </section>

                <section className="mt-10" aria-labelledby="photo-api-parameters">
                    <h2 id="photo-api-parameters" className="font-serif text-3xl text-charcoal">Choose a pool</h2>
                    <p>Both parameters are optional. Use the slug from the public album URL, after <code>/album/</code>. Set <code>featured=true</code> to request featured photos. The default, <code>featured=false</code>, includes every eligible photo.</p>
                    <dl className="app-api-examples">
                        {examples.map(([query, description]) => (
                            <div key={query}>
                                <dt><code>{`/v1/photos/random${query}`}</code></dt>
                                <dd>{description}</dd>
                            </div>
                        ))}
                    </dl>
                </section>

                <section className="mt-10" aria-labelledby="photo-api-response">
                    <h2 id="photo-api-response" className="font-serif text-3xl text-charcoal">Read the response</h2>
                    <p>Use <code>imageUrl</code> to download the full-resolution file. The response includes <code>id</code>, <code>albumSlug</code>, <code>albumUrl</code>, <code>width</code>, <code>height</code>, and <code>bytes</code>. <code>featured</code> describes the selected photo, and <code>fallbackUsed</code> tells you whether an album pick fell back to all its photos.</p>
                    <p>Every request draws again, so a photo can repeat. Downloads can be large. Use <code>bytes</code> to check the size first and reuse the downloaded file when you need the same photo again.</p>
                </section>

                <section className="mt-10" aria-labelledby="photo-api-errors">
                    <h2 id="photo-api-errors" className="font-serif text-3xl text-charcoal">Errors and limits</h2>
                    <p><code>400</code> means a query parameter is invalid. <code>404</code> means the requested pool has no eligible photos. Slow down if you receive <code>403</code> or <code>429</code> during repeated requests. If the service returns <code>503</code>, wait before trying again.</p>
                </section>
            </article>
        </div>
    )
}
