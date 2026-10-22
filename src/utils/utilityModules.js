// Shared by the Utilities landing page, coming-soon pages, and navbar dropdown.
export const UTILITY_MODULES = Object.freeze([
    {
        id: 'web-editor',
        path: '/editor',
        title: 'Web Editor',
        detail: 'Edit RAW files and photos in your browser.',
        summary: 'Edit photographs in your browser',
    },
    {
        id: 'truongroom',
        path: '/utilities/truongroom',
        title: 'TruongRoom',
        detail: 'In development.',
        summary: 'Coming soon',
        comingSoon: true,
    },
    {
        id: 'truongcam',
        path: '/utilities/truongcam',
        title: 'TruongCam',
        detail: 'An iPhone camera app with Bayer RAW capture and manual controls.',
        summary: 'RAW camera for iPhone',
    },
    {
        id: 'truongnoiser',
        path: '/utilities/truongnoiser',
        title: 'TruongNoiser',
        detail: 'Denoise photos locally on your iPhone.',
        summary: 'Coming soon',
        comingSoon: true,
    },
    {
        id: 'truongscaler',
        path: '/utilities/truongscaler',
        title: 'TruongScaler',
        detail: 'Upscale photos locally on your iPhone.',
        summary: 'Coming soon',
        comingSoon: true,
    },
])
