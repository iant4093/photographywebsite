import { Link } from 'react-router'
import { APP_MODULES } from '../utils/appModules'
import './Explore.css'
import './Apps.css'
import './TruongCam.css'
import './DesktopApp.css'

const APPS = {
    truongflix: {
        title: 'TruongFlix',
        intro: 'Turn the movies, shows, and music on your drives into one media library on Mac or Windows. Play them in the app, pick up where you left off, and keep your library on your computer.',
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
            'Listen to your music library with playlists, a playback queue, and synced lyrics when available.',
            'Watch from a browser on your home network, or use optional Tailscale access away from home.',
            'Add your own IPTV playlists for live TV or use the built-in client to stream and download torrents you add.',
            'Browse, install, and launch games from a separate library on Windows.',
        ],
        screenshotSize: [1200, 675],
        hero: ['home', 'Home library', 'Home screen with a featured show, ratings, and a Continue Watching row'],
        screens: [
            ['player', 'Built-in player', 'Playback controls over a scene from Big Buck Bunny', [896, 560]],
            ['detail', 'Show details', 'Show page with artwork, ratings, cast, and an episode list'],
            ['wrapped', 'TruongFlix Wrapped', 'Yearly viewing summary with watch time and favorite genres'],
            ['games-library', 'Games library on Windows', 'Games library with play time and a Continue Playing row'],
            ['music-browse', 'Music discovery', 'Music browsing with featured releases, genre filters, and album charts', [896, 504]],
        ],
        screenshotNote: 'Library previews use sample artwork from TMDB, and Music shows live Apple Music chart data. The player shows Big Buck Bunny (© Blender Foundation, CC BY 3.0).',
        screenshotRevision: '7caf78e34e67dbacd982b702a75d119392916b3b',
    },
    truongphoto: {
        title: 'TruongPhoto',
        intro: 'A local photo and video library for Mac and Windows. Browse the files already on your drives, inspect camera settings, and find photos by what’s in them using AI that runs on your computer.',
        platforms: 'Mac and Windows',
        downloads: [
            {
                platform: 'macos', label: 'macOS', file: 'TruongPhoto-macOS.dmg', requirement: 'macOS 14 or later (Apple silicon)',
                instructions: 'Open the DMG and drag TruongPhoto into Applications. If macOS asks you to approve the first launch, follow the installation guide below.',
            },
            {
                platform: 'windows', label: 'Windows', file: 'TruongPhoto-Windows-Setup.exe', requirement: 'Windows 10 version 1809 or later (x64)',
                instructions: 'Run the setup file and follow the installer. The installation guide covers the SmartScreen prompt if it appears.',
            },
        ],
        setup: 'Add folders from your drives to build the library. Enable the optional models you want in Settings under Local AI & Models.',
        features: [
            'Browse photos, camera RAW files, and videos in a date-grouped timeline while the originals stay in place.',
            'Find photos by subject, detected text, people, or camera settings. Refine a search with the optional local Ask AI workspace.',
            'Inspect lens and exposure details, see a live histogram, and browse geotagged photos on an offline map.',
            'Share selected folders with separate profiles. Open the library in a browser on your local network or connect remotely over Tailscale.',
        ],
        screenshotSize: [1024, 640],
        hero: ['timeline', 'Photo timeline', 'Date-grouped library with mountain and waterfall photos'],
        screens: [
            ['lightbox', 'Photo viewer', 'Mountain photo with an EXIF inspector and RGB histogram', [896, 560]],
            ['ask-ai', 'Ask AI', 'Local search for mountain photos with removable filters', [896, 560]],
            ['search', 'Search and filters', 'Photo results with camera, lens, and EXIF filters', [896, 560]],
        ],
        screenshotNote: 'The screenshots show a local photography library with optional AI models enabled.',
        screenshotRevision: 'fbf33c074b36b2c46650ab9b617466837bd1ef9f',
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
        setup: 'Start with a scan to review cleanup candidates. Full Disk Access is optional and lets the app inspect additional locations.',
        features: [
            'Break down System Data into snapshots, purgeable space, Spotlight files, and other storage categories.',
            'Review app caches, logs, and unfinished downloads by category before cleaning.',
            'Find Xcode build data, simulators, and package caches in the Developer view.',
            'Explore the largest folders and files with the interactive Space Lens chart.',
            'Review large or older files and find leftover files associated with apps you uninstall.',
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
        screenshotRevision: 'e124e542687cf7f1bbca51ed2ab26fbecb40b182',
    },
    truongpaper: {
        title: 'TruongPaper',
        intro: 'Set your desktop wallpaper from the Ian Truong Photography library, Steam Workshop, or your own files. Mix photos and live wallpapers in playlists and choose what plays on each screen.',
        platforms: 'Mac and Windows',
        downloads: [
            {
                platform: 'macos', label: 'macOS', file: 'TruongPaper-macOS.dmg', requirement: 'macOS 14.2 or later (Apple silicon)',
                instructions: 'Open the DMG and drag TruongPaper into Applications. If macOS asks you to approve the first launch, follow the installation guide below.',
            },
            {
                platform: 'windows', label: 'Windows', file: 'TruongPaper-Windows-Setup.exe', requirement: 'Windows 10 version 1809 or later (x64)',
                instructions: 'Run the setup file and follow the installer. The installation guide covers the SmartScreen prompt if it appears.',
            },
        ],
        setup: <>Browse and cache photos from the <Link to="/apps/photo-api">Photo API</Link> without an account. Workshop downloads can use a guest source when available or Steam with a Wallpaper Engine license.</>,
        features: [
            'Shuffle full-resolution photos from public albums without repeats until the selection has played. Save them for offline rotation or import your own files.',
            'Browse Steam Workshop and try experimental Wallpaper Engine scene, video, and web playback. Application wallpapers require Windows.',
            'Set separate wallpapers, playlists, timers, and volume for each monitor.',
            'Adjust scene properties, audio reactivity, playback speed, and color, then save your settings as presets.',
            'Pause animation when the desktop is covered, your laptop is on battery, or the screen locks.',
        ],
        screenshotSize: [1044, 988],
        hero: ['studio-library', 'Wallpaper library', 'Wallpaper library with search, wallpaper types, and desktop controls'],
        screens: [
            ['photos-api', 'Photo API queue', 'Photo API view with saved albums, cache controls, and history'],
            ['scene-inspector', 'Scene controls', 'Wallpaper Engine scene inspector with effect settings and presets'],
            ['monitors-playlists', 'Display settings', 'Displays view with the wallpaper assigned to each monitor'],
        ],
        screenshotNote: 'Captured from the browser preview with sample data.',
        screenshotRevision: '2bab3a3e21d8167c6ff2ca90e20b1e2683a67094',
    },
    truongsync: {
        title: 'TruongSync',
        intro: 'Import a shoot from your camera card, add GPS coordinates from a GPX track, and back up the results to Google Drive or an external drive on Mac or Windows.',
        platforms: 'Mac and Windows',
        downloads: [
            {
                platform: 'macos', label: 'macOS', file: 'TruongSync-macOS.dmg', requirement: 'macOS 14 or later (Apple silicon)',
                instructions: 'Open the DMG and drag TruongSync into Applications. If macOS asks you to approve the first launch, follow the installation guide below.',
            },
            {
                platform: 'windows', label: 'Windows', file: 'TruongSync-Windows-Setup.exe', requirement: 'Windows 10 version 1809 or later (x64)',
                instructions: 'Run the setup file and follow the installer. The installation guide covers the SmartScreen prompt if it appears.',
            },
        ],
        setup: 'Choose a library folder and set up your import and backup profiles. The installers include rclone and ExifTool.',
        features: [
            'Detect camera cards, check available space, and sort RAW files, JPEGs, and videos into customizable folders by shoot date.',
            'Match capture times to GPX tracks, preview the route, then write GPS coordinates to supported photos in batches.',
            'Schedule additive two-way sync with Google Drive or an external drive, with separate tools to verify backups and restore files.',
            'Review individual imports, geotagging jobs, and transfers in the activity history.',
        ],
        screenshotSize: [1024, 640],
        hero: ['import', 'SD card import', 'Detected camera card with import checks and a destination folder template'],
        screens: [
            ['geotag', 'GPS geotagging', 'GPX route preview with matched photos and GPS coordinates', [896, 560]],
            ['cloud-sync', 'Google Drive sync', 'Sync profiles with backup freshness and verification status', [896, 560]],
            ['external-backup', 'External drive backup', 'Backup profiles for connected and offline drives', [896, 560]],
        ],
        screenshotNote: 'Screenshots from the development version.',
        screenshotRevision: 'd237dfd231c362cfa4ed952eff0b1106f4aa3fed',
    },
    truongstream: {
        title: 'TruongStream',
        intro: 'A USB webcam studio for Mac and Windows. Use a supported Canon, Sony, Nikon, or Fujifilm camera for calls or streaming, with exposure and color controls alongside the live preview.',
        platforms: 'Mac and Windows',
        downloads: [
            {
                platform: 'macos', label: 'macOS', file: 'TruongStream-macOS.dmg', requirement: 'macOS 14.2 or later (Apple silicon)',
                instructions: 'Open the DMG and drag TruongStream into Applications. If macOS asks you to approve the first launch, follow the installation guide below.',
            },
            {
                platform: 'windows', label: 'Windows', file: 'TruongStream-Windows-Setup.exe', requirement: 'Windows 10 version 1809 or later (x64)',
                instructions: 'Run the setup file and follow the installer. The installation guide covers the SmartScreen prompt if it appears.',
            },
        ],
        setup: 'Connect a supported camera over USB or plug in an HDMI capture card, then choose your video source in TruongStream.',
        features: [
            'Connect over USB and control shutter speed, aperture, ISO, white balance, and focus as supported by the camera. Canon EOS R7 supports tap-to-focus in the live preview.',
            'Capture uncompressed HDMI video up to 4K, with the option to keep compatible USB camera controls active at the same time.',
            'Apply built-in color presets or import your own .cube LUT, with a split preview to compare the grade.',
            'Use Windows virtual camera output or send video to OBS through Clean Output Mode or the local MJPEG stream. Native macOS virtual camera output requires a signed and notarized camera extension.',
            'Canon EOS R7 has been tested on hardware. Sony, Nikon, and Fujifilm camera protocols are implemented and listed in the GitHub compatibility table.',
        ],
        screenshotSize: [1056, 672],
        hero: ['camera-controls', 'Camera controls', 'Canon EOS R7 preview alongside exposure, white balance, and autofocus controls'],
        screens: [
            ['lut-split-wipe', 'LUT comparison', 'Split view comparing ungraded video with a cinematic color preset', [880, 560]],
            ['system-hdmi', 'HDMI capture', 'System panel showing 4K HDMI input settings and pipeline diagnostics', [880, 560]],
        ],
        screenshotNote: 'Captured from the project’s browser preview with a simulated camera feed.',
        screenshotRevision: 'a9a858c4166b6f33c6a2c6718f6df45f6f3ba58e',
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
    const comingSoon = APP_MODULES.find(module => module.id === moduleId)?.comingSoon
    const platform = getPlatform(navigator)
    const download = !comingSoon && app.downloads.find(option => option.platform === platform)
    const downloadUrl = file => `${repository}/releases/latest/download/${file}`
    const [heroFile, heroCaption, heroAlt] = app.hero
    const availability = comingSoon ? `Coming soon for ${app.platforms}.` : platform === 'mobile'
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
                        {!comingSoon && <p className="cam-install-note">
                            {download && <>{download.requirement} · </>}
                            <a href="#installation">How to install</a>
                        </p>}
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
                    <p className="desktop-app-note">{app.screenshotNote} {app.screenshotRevision && <a href={`${repository}/blob/${app.screenshotRevision}/README.md#screenshots`} target="_blank" rel="noreferrer">Screenshot details ↗</a>}</p>
                </section>
                {!comingSoon && <section id="installation" className="cam-install" aria-labelledby="app-install-title">
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
                        <p className="desktop-app-note">{app.setup}</p>
                        <a className="cam-guide" href={`${repository}#install`} target="_blank" rel="noreferrer">Full installation guide ↗</a>
                    </div>
                </section>}
            </div>
        </div>
    )
}
