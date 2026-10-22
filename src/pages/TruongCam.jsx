import { Link } from 'react-router'
import './Explore.css'
import './Utilities.css'
import './TruongCam.css'

const REPOSITORY = 'https://github.com/iant4093/TruongCam'
const DOWNLOAD = `${REPOSITORY}/releases/latest/download/TruongCam.ipa`
const ASSETS = '/utilities/truongcam'

const features = [
    'Bayer RAW (DNG) and JPEG capture, with physical lens selection.',
    'Manual shutter speed, ISO, focus, and white balance.',
    'Histogram, grid, level, zebras, focus peaking, and focus loupe.',
    'Timer, exposure and focus bracketing, and interval shooting.',
    'A local photo library with original-file sharing and Recently Deleted.',
]
const screens = [
    ['tools', 'Capture tools'],
    ['library', 'Photo library'],
    ['viewer', 'Photo viewer'],
]

export default function TruongCam() {
    return (
        <div className="explore-page utilities-page truongcam-page animate-fade-in pt-[74px]">
            <div className="cam-shell">
                <Link to="/utilities" className="explore-back">← All Utilities modules</Link>
                <header className="cam-hero">
                    <div className="cam-hero-copy">
                        <div className="cam-title"><img src={`${ASSETS}/icon.png`} alt="" width="56" height="56" /><h1>TruongCam</h1></div>
                        <p className="cam-intro">An iPhone camera app with Bayer RAW capture and manual controls. Photos save to a folder you choose in Files.</p>
                        <div className="cam-actions">
                            <a className="cam-button cam-button-primary" href={DOWNLOAD}>Download for iPhone <span aria-hidden="true">↓</span></a>
                            <a className="cam-button" href={REPOSITORY} target="_blank" rel="noreferrer">View on GitHub <span aria-hidden="true">↗</span></a>
                        </div>
                        <p className="cam-install-note">iOS 27+ · Unsigned IPA · Signing required · <a href="#installation">How to install</a></p>
                    </div>
                    <figure className="cam-hero-visual">
                        <div className="cam-phone"><img src={`${ASSETS}/camera.webp`} alt="Camera screen in TruongCam" width="1206" height="2622" fetchPriority="high" /></div>
                        <figcaption>Camera</figcaption>
                    </figure>
                </header>
                <section className="cam-features" aria-labelledby="cam-features-title">
                    <h2 id="cam-features-title">Features</h2>
                    <ul className="cam-feature-list">{features.map((feature, index) => <li key={feature}><span aria-hidden="true">{String(index + 1).padStart(2, '0')}</span><p>{feature}</p></li>)}</ul>
                </section>
                <section className="cam-screenshots" aria-labelledby="cam-gallery-title">
                    <h2 id="cam-gallery-title">Screenshots</h2>
                    <div className="cam-gallery">{screens.map(([id, title]) => <figure key={id}><div className="cam-screen-mat"><img src={`${ASSETS}/${id}.webp`} alt={`${title} screen in TruongCam`} width="1206" height="2622" loading="lazy" /></div><figcaption>{title}</figcaption></figure>)}</div>
                </section>
                <section id="installation" className="cam-install" aria-labelledby="cam-install-title">
                    <h2 id="cam-install-title">Installation</h2>
                    <div>
                        <ol>
                            <li>Download the latest IPA using the button above.</li>
                            <li>Import it into a sideloading or signing tool and sign it with your Apple account.</li>
                            <li>Open TruongCam, allow camera access, and select an “On My iPhone” folder in Files outside the app’s own folder. Cloud libraries are not supported.</li>
                        </ol>
                        <a className="cam-guide" href={`${REPOSITORY}#install`} target="_blank" rel="noreferrer">Full installation guide ↗</a>
                    </div>
                </section>
            </div>
        </div>
    )
}
