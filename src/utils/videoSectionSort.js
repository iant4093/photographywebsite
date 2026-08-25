import { HOME_SECTION_SORT_OPTIONS, sortHomePhotoSections } from './homeSectionSort'

export const VIDEO_SECTION_SORT_OPTIONS = [
    ...HOME_SECTION_SORT_OPTIONS.slice(0, 5),
    'Most video albums',
    'Fewest video albums',
]

export const sortVideoSections = sortHomePhotoSections
