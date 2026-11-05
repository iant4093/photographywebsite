// Shared by the Apps landing page, coming-soon pages, and navbar dropdown.
export const APP_MODULES = Object.freeze([
    {
        id: 'web-editor',
        path: '/editor',
        title: 'Web Editor',
        detail: 'Edit RAW files and photos in your browser.',
        summary: 'Edit photographs in your browser',
    },
    {
        id: 'truongroom',
        path: '/apps/truongroom',
        title: 'TruongRoom',
        detail: 'In development.',
        summary: 'Coming soon',
        comingSoon: true,
    },
    {
        id: 'truongcam',
        path: '/apps/truongcam',
        title: 'TruongCam',
        detail: 'An iPhone camera app with Bayer RAW capture and manual controls.',
        summary: 'RAW camera for iPhone',
    },
    {
        id: 'truongnoiser',
        path: '/apps/truongnoiser',
        title: 'TruongNoiser',
        detail: 'Denoise photos locally on your iPhone.',
        summary: 'Photo denoising for iPhone',
    },
    {
        id: 'truongscaler',
        path: '/apps/truongscaler',
        title: 'TruongScaler',
        detail: 'Upscale photos to 2× locally on your iPhone.',
        summary: '2× photo upscaling for iPhone',
    },
])
