import { Link } from 'react-router'
import './Explore.css'
import './Apps.css'
import './TruongCam.css'
import './DesktopApp.css'

const APPS = {
    truongflix: {
        title: 'TruongFlix',
        intro: 'Turn the movies and shows on your drives into a Netflix-style library on Mac or Windows. Play them in the app, pick up where you left off, and keep your library on your computer.',
        platforms: 'Mac and Windows',
        downloads: [
            {
                platform: 'macos', label: 'macOS', file: 'TruongFlix-macOS.dmg', requirement: 'Apple silicon Mac',
                instructions: 'Open the DMG and drag TruongFlix into Applications. Follow the linked guide if macOS asks you to approve the first launch.',
            },
            {
                platform: 'windows', label: 'Windows', file: 'TruongFlix-Windows-Setup.exe', requirement: 'Windows 10 or later (x64)',
                instructions: 'Run the setup file and follow the installer. The linked guide covers the SmartScreen prompt if it appears.',
            },
        ],
        setup: 'On first launch, add your media folders and enter a free TMDB API key to fetch artwork and title details.',
        features: [
            'Scan local folders for movies and shows, with artwork, cast, and episode details from TMDB.',
            'Play media with the built-in mpv player, including chapter thumbnails, subtitles, and skip-intro controls.',
            'Keep separate watch histories, Continue Watching rows, and viewing limits for each profile.',
            'Add your own IPTV playlists for live TV or use the built-in client to stream and download torrents you add.',
            'Browse, install, and launch games from a separate library on Windows.',
        ],
        screenshotSize: [1200, 675],
        hero: ['home', 'Home library', 'Home screen with a featured show, ratings, and a Continue Watching row'],
        screens: [
            ['player', 'Built-in player', 'Playback controls over a scene from Big Buck Bunny', [1200, 750]],
            ['detail', 'Show details', 'Show page with artwork, ratings, cast, and an episode list'],
            ['wrapped', 'TruongFlix Wrapped', 'Yearly viewing summary with watch time and favorite genres'],
            ['games-library', 'Games library on Windows', 'Games library with play time and a Continue Playing row'],
        ],
        screenshotNote: 'Library previews use sample artwork from TMDB. The player shows Big Buck Bunny (© Blender Foundation, CC BY 3.0).',
        screenshotRevision: 'ef0ed9525a96830f3c4bc1938771eeeeb279248a',
    },
    truongcleaner: {
        title: 'TruongCleaner',
        intro: 'See what’s inside System Data on your Mac, from snapshots to app caches and developer files. Review what can be cleaned and send selected files to the Trash by default.',
        platforms: 'Mac',
        downloads: [
            {
                platform: 'macos', label: 'macOS', file: 'TruongCleaner.dmg', requirement: 'macOS 26 or later (Apple silicon)',
                instructions: 'Open the DMG and drag TruongCleaner into Applications. Follow the linked guide if macOS asks you to approve the first launch.',
            },
        ],
        releaseNote: 'Preview build',
        setup: 'Start with a scan to review cleanup candidates. Full Disk Access is optional and lets the app inspect additional locations.',
        features: [
            'Break down System Data into snapshots, purgeable space, Spotlight files, and other storage categories.',
            'Review app caches, logs, and unfinished downloads by category before cleaning.',
            'Find Xcode build data, simulators, and package caches in the Developer view.',
            'Explore the largest folders and files with the interactive Space Lens chart.',
            'Restore items from cleanup history when they were moved to the Trash.',
        ],
        screenshotSize: [1210, 792],
        hero: ['overview', 'Storage overview', 'Macintosh HD storage breakdown with space recommendations'],
        screens: [
            ['smartclean', 'Smart Clean', 'Cleanup candidates grouped by category with sizes and selection checkboxes'],
            ['systemdata', 'System Data', 'Storage breakdown with entries for snapshots, Spotlight, and swap'],
            ['developer', 'Developer storage', 'Xcode build data and a list of simulators'],
            ['spacelens', 'Space Lens', 'Sunburst chart showing the largest folders in a directory'],
        ],
        screenshotNote: 'Captured in the macOS app.',
        screenshotRevision: 'e1f6f70a0dc022cc62e7e0084589aff0fe7a9240',
    },
}

function getPlatform({ userAgentData, platform, userAgent, maxTouchPoints }) {
    const platformName = userAgentData?.platform || platform
    // iPadOS can advertise a Mac desktop user agent in Safari.
    if (userAgentData?.mobile || /android|iphone|ipad|ipod|mobile/i.test(`${platformName} ${userAgent}`)
        || (/mac/i.test(platformName) && maxTouchPoints > 1)) return 'mobile'
    if (/^mac/i.test(platformName) || (!platformName && /macintosh/i.test(userAgent))) return 'macos'
    if (/^win/i.test(platformName) || (!platformName && /windows/i.test(userAgent))) return 'windows'
    return 'other'
}

export default function DesktopApp({ moduleId }) {
    const app = APPS[moduleId]
    const repository = `https://github.com/iant4093/${app.title}`
    const assets = `/apps/${moduleId}`
    const platform = getPlatform(navigator)
    const download = app.downloads.find(option => option.platform === platform)
    const downloadUrl = file => `${repository}/releases/latest/download/${file}`
    const [heroFile, heroCaption, heroAlt] = app.hero
    const availability = platform === 'mobile'
        ? `Visit this page on ${app.platforms === 'Mac' ? 'your Mac' : 'your Mac or Windows computer'} to download.`
        : `Available for ${app.platforms}.`

    return (
        <div className="explore-page apps-page desktop-app-page animate-fade-in pt-[74px]">
            <div className="cam-shell">
                <Link to="/apps" state={{ restoreScroll: '/apps' }} className="explore-back">← All apps</Link>
                <header className="cam-hero">
                    <div className="cam-hero-copy">
                        <div className="cam-title"><img src={`${assets}/icon.png`} alt="" width="56" height="56" /><h1>{app.title}</h1></div>
                        <p className="cam-intro">{app.intro}</p>
                        {!download && <p className="desktop-app-availability">{availability}</p>}
                        <div className="cam-actions">
                            {download && <a className="cam-button cam-button-primary" href={downloadUrl(download.file)}>Download for {download.label} <span aria-hidden="true">↓</span></a>}
                            <a className="cam-button" href={repository} target="_blank" rel="noreferrer">View on GitHub <span aria-hidden="true">↗</span></a>
                        </div>
                        <p className="cam-install-note">
                            {download && <>{download.requirement} · </>}
                            {app.releaseNote && <>{app.releaseNote} · </>}
                            <a href="#installation">How to install</a>
                        </p>
                    </div>
                    <figure className="cam-hero-visual">
                        <img className="desktop-app-hero-image" src={`${assets}/${heroFile}.webp`} alt={heroAlt} width={app.screenshotSize[0]} height={app.screenshotSize[1]} fetchPriority="high" />
                        <figcaption>{heroCaption}</figcaption>
                    </figure>
                </header>
                <section className="cam-features" aria-labelledby="app-features-title">
                    <h2 id="app-features-title">Features</h2>
                    <ul className="cam-feature-list">{app.features.map((feature, index) => <li key={feature}><span aria-hidden="true">{String(index + 1).padStart(2, '0')}</span><p>{feature}</p></li>)}</ul>
                </section>
                <section className="cam-screenshots" aria-labelledby="app-gallery-title">
                    <h2 id="app-gallery-title">Screenshots</h2>
                    <div className="cam-gallery">
                        {app.screens.map(([file, title, description, [width, height] = app.screenshotSize]) => (
                            <figure key={file}>
                                <div className="cam-screen-mat"><img src={`${assets}/${file}.webp`} alt={description} width={width} height={height} loading="lazy" /></div>
                                <figcaption>{title}</figcaption>
                            </figure>
                        ))}
                    </div>
                    <p className="desktop-app-note">{app.screenshotNote} <a href={`${repository}/blob/${app.screenshotRevision}/README.md#screenshots`} target="_blank" rel="noreferrer">Screenshot details ↗</a></p>
                </section>
                <section id="installation" className="cam-install" aria-labelledby="app-install-title">
                    <h2 id="app-install-title">Installation</h2>
                    <div className="desktop-app-instructions">
                        {app.downloads.map(option => (
                            <section key={option.platform}>
                                <h3>{option.label}</h3>
                                <p className="desktop-app-note">
                                    {option.requirement}
                                    {platform !== 'mobile' && <> · <a href={downloadUrl(option.file)}>{option.label} installer</a></>}
                                </p>
                                <p>{option.instructions}</p>
                            </section>
                        ))}
                        <p>{app.setup}</p>
                        <a className="cam-guide" href={`${repository}#install`} target="_blank" rel="noreferrer">Full installation guide ↗</a>
                    </div>
                </section>
            </div>
        </div>
    )
}
