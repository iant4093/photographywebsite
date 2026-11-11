import { Link } from 'react-router'
import './Explore.css'
import './Apps.css'
import './TruongCam.css'
import './PhotoApp.css'

const APPS = {
    truongnoiser: {
        title: 'TruongNoiser',
        intro: 'Reduce photo noise on your iPhone while keeping the original pixel dimensions. Processing runs locally, with separate input and output folders in Files.',
        features: [
            'Native-resolution denoising with NAFNet (Fast), CGNet (Better), and CGNet (Best, 8-pass).',
            'Independent luminance and color strength controls, recorded with each saved result.',
        ],
        comparison: 'Saved CGNet result · original left, denoised right',
        detail: 'Noise detail',
        detailAlt: 'Zoomed comparison with the noisy input on the left and the saved CGNet denoised result on the right',
        settingsAlt: 'CGNet model selection, independent luminance and color strengths, and export settings',
        companion: 'TruongScaler',
    },
    truongscaler: {
        title: 'TruongScaler',
        intro: 'Enlarge photos to twice their width and height on your iPhone. Processing runs locally, with separate input and output folders in Files.',
        features: [
            'Native 2× enlargement with QuickSRNet (Fast), EDSR (Balanced), and HAT-S (Best).',
            'Linear Display P3 processing with HDR headroom, alpha preservation, and optional source-derived grain retention.',
        ],
        comparison: 'Saved HAT-S result · original left, 2× enlargement right',
        detail: 'Upscale detail',
        detailAlt: 'Zoomed flower comparison with the original on the left and the saved HAT-S 2× enlargement on the right',
        settingsAlt: 'HAT-S model selection, export format, and grain retention settings',
        companion: 'TruongNoiser',
    },
}

const sharedFeatures = [
    'On-device Core ML processing of supported photos and RAW files from a chosen folder, including subfolders.',
    'Batch processing with Stop, resumable jobs, and saved progress for interrupted work.',
    'Input and Output libraries with zoomable before/after comparisons, frozen originals, and processing history.',
    'Linear DNG, TIFF, SDR PNG and JPEG exports, plus HDR HEIC when supported and verified on your device.',
    'Original-file sharing and a recoverable Recently Deleted collection for saved results.',
]

export default function PhotoApp({ moduleId }) {
    const app = APPS[moduleId]
    const repository = `https://github.com/iant4093/${app.title}`
    const assets = `/apps/${moduleId}`
    const screens = [
        ['input-library', 'Input library', 'Input library with photos from the selected Files folder'],
        ['output-library', 'Output library', 'Output library with saved processed photos'],
        ['model-settings', 'Processing settings', app.settingsAlt],
        ['detail-comparison', app.detail, app.detailAlt],
    ]

    return (
        <div className="explore-page apps-page photo-app-page animate-fade-in pt-[74px]">
            <div className="cam-shell">
                <Link to="/apps" state={{ restoreScroll: '/apps' }} className="explore-back">← All apps</Link>
                <header className="cam-hero">
                    <div className="cam-hero-copy">
                        <div className="cam-title"><img src={`${assets}/icon.png`} alt="" width="56" height="56" /><h1>{app.title}</h1></div>
                        <p className="cam-intro">{app.intro}</p>
                        <div className="cam-actions">
                            <a className="cam-button cam-button-primary" href={`${repository}/releases/latest/download/${app.title}.ipa`}>Download for iPhone <span aria-hidden="true">↓</span></a>
                            <a className="cam-button" href={repository} target="_blank" rel="noreferrer">View on GitHub <span aria-hidden="true">↗</span></a>
                        </div>
                        <p className="cam-install-note">iOS 27+ · Unsigned IPA · Signing required · <a href="#installation">How to install</a></p>
                    </div>
                    <figure className="cam-hero-visual">
                        <div className="cam-phone"><img src={`${assets}/processed-viewer.webp`} alt={`Before/after viewer in ${app.title}: ${app.comparison}`} width="1206" height="2622" fetchPriority="high" /></div>
                        <figcaption>{app.comparison}</figcaption>
                    </figure>
                </header>
                <section className="cam-features" aria-labelledby="app-features-title">
                    <h2 id="app-features-title">Features</h2>
                    <ul className="cam-feature-list">{[...app.features, ...sharedFeatures].map((feature, index) => <li key={feature}><span aria-hidden="true">{String(index + 1).padStart(2, '0')}</span><p>{feature}</p></li>)}</ul>
                </section>
                <section className="cam-screenshots" aria-labelledby="app-gallery-title">
                    <h2 id="app-gallery-title">Screenshots</h2>
                    <div className="cam-gallery">{screens.map(([id, title, description]) => <figure key={id}><div className="cam-screen-mat"><img src={`${assets}/${id}.webp`} alt={`${description} in ${app.title}`} width="1206" height="2622" loading="lazy" /></div><figcaption>{title}</figcaption></figure>)}</div>
                    <p className="app-screenshot-note">Captured in an iOS Simulator. <a href={`${repository}/blob/main/docs/screenshots/provenance.json`} target="_blank" rel="noreferrer">Photo credits and screenshot details ↗</a></p>
                </section>
                <section id="installation" className="cam-install" aria-labelledby="app-install-title">
                    <h2 id="app-install-title">Installation</h2>
                    <div>
                        <ol>
                            <li>Download the latest IPA using the button above.</li>
                            <li>Import it into a sideloading or signing tool and sign it with your Apple account.</li>
                            <li>Open {app.title} and choose an input folder of supported photos and a separate writable output folder in Files.</li>
                        </ol>
                        <p className="app-storage-note">Choose folders outside the app’s own container to keep them when removing the app. Keep the output folder’s originals, metadata, and comparison-originals folders together to preserve saved results and before/after comparisons.</p>
                        <a className="cam-guide" href={`${repository}#install`} target="_blank" rel="noreferrer">Full installation guide ↗</a>
                        <p className="app-companion">Also in Apps: <Link to={`/apps/${app.companion.toLowerCase()}`}>{app.companion} →</Link></p>
                    </div>
                </section>
            </div>
        </div>
    )
}
