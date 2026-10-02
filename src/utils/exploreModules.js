// The single list of Explore modules. The Explore landing page and the
// desktop navigation dropdown both render from it, so a module added here
// appears in both places.
export const EXPLORE_MODULES = Object.freeze([
    {
        id: 'immersive',
        path: '/explore/immersive-gallery',
        title: 'Immersive Gallery',
        detail: 'Walk through a living museum generated from every public photography collection.',
        summary: 'Walk through a living museum',
    },
    {
        id: 'color',
        path: '/explore/colors',
        title: 'Color Explorer',
        detail: 'Browse photographs by the colors that meaningfully shape each frame.',
        summary: 'Browse by dominant color',
        prefetch: 'color',
    },
    {
        id: 'lens',
        path: '/explore/lenses',
        title: 'Lens Explorer',
        detail: 'See how each lens renders the archive, from wide landscapes to distant wildlife.',
        summary: 'See the archive lens by lens',
        prefetch: 'lens',
    },
    {
        id: 'exposure',
        path: '/explore/exposure',
        title: 'Exposure Explorer',
        detail: 'Browse by aperture, shutter speed, ISO, and focal length.',
        summary: 'Aperture, shutter, ISO, focal length',
        prefetch: 'exposure',
    },
    {
        id: 'time',
        path: '/explore/time-of-day',
        title: 'Time of Day Explorer',
        detail: 'Follow the changing character of light from dawn through night.',
        summary: 'Light from dawn through night',
        prefetch: 'time',
    },
    {
        id: 'season',
        path: '/explore/seasons',
        title: 'Season Explorer',
        detail: 'See the archive shift through winter, spring, summer, and autumn.',
        summary: 'Winter, spring, summer, autumn',
        prefetch: 'season',
    },
    {
        id: 'guess',
        path: '/explore/guess-settings',
        title: 'Guess the Settings',
        detail: 'Read the frame, choose the camera setting, and test your eye.',
        summary: 'Test your eye for camera settings',
        prefetch: 'sample',
    },
])
