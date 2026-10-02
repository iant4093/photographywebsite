import { useState } from 'react'
import { Link } from 'react-router'
import useNavSections from '../hooks/useNavSections'
import { EXPLORE_MODULES } from '../utils/exploreModules'
import NavDropdown from './NavDropdown'
import './NavDropdowns.css'

function SectionLinks({ mediaType, sections, failed, pathname }) {
    const noun = mediaType === 'video' ? 'video' : 'photo'
    return (
        <>
            <div className="linen-nav-dropdown-head">
                <span>{mediaType === 'video' ? 'Video' : 'Photo'} sections</span>
                <Link to={mediaType === 'video' ? '/videos' : '/#photo-albums'}>All {noun} albums →</Link>
            </div>
            {sections?.length ? (
                <ul className={`linen-nav-dropdown-list${sections.length > 8 ? ' linen-nav-dropdown-list--columns' : ''}`}>
                    {sections.map(({ category, count }) => {
                        const to = `/sections/${mediaType}/${encodeURIComponent(category)}`
                        const current = pathname === to
                        return (
                            <li key={category}>
                                <Link to={to} className={current ? 'is-active' : undefined} aria-current={current ? 'page' : undefined}>
                                    <span>{category}</span>
                                    <small>{count}</small>
                                </Link>
                            </li>
                        )
                    })}
                </ul>
            ) : (
                <p className="linen-nav-dropdown-note">
                    {failed ? 'Sections are unavailable right now.' : (sections ? `No ${noun} sections yet.` : 'Loading sections…')}
                </p>
            )}
        </>
    )
}

// Hover dropdowns for the desktop masthead. Loaded on its own only where a
// hover-capable desktop layout can use it, keeping the entry bundle lean.
export default function NavDropdowns({ pathname, photoActive, videoActive, exploreActive }) {
    const [dropdown, setDropdown] = useState(null)
    const photoSections = useNavSections('photo')
    const videoSections = useNavSections('video')
    // Remember where a dropdown was opened so navigating away closes it.
    const openDropdown = dropdown?.pathname === pathname ? dropdown.id : null
    const dropdownProps = (id) => ({
        id,
        open: openDropdown === id,
        onOpen: (next) => {
            if (next === 'photo') photoSections.refresh()
            if (next === 'video') videoSections.refresh()
            setDropdown({ id: next, pathname })
        },
        onClose: (closing) => setDropdown(current => (current?.id === closing ? null : current)),
    })

    return (
        <>
            <NavDropdown {...dropdownProps('photo')} label="Photographs" to="/" active={photoActive}>
                <SectionLinks mediaType="photo" pathname={pathname} {...photoSections} />
            </NavDropdown>
            <NavDropdown {...dropdownProps('video')} label="Videos" to="/videos" active={videoActive}>
                <SectionLinks mediaType="video" pathname={pathname} {...videoSections} />
            </NavDropdown>
            <NavDropdown {...dropdownProps('explore')} label="Explore" to="/explore" active={exploreActive}>
                <div className="linen-nav-dropdown-head">
                    <span>Explore modules</span>
                    <Link to="/explore">All modules →</Link>
                </div>
                <ul className="linen-nav-dropdown-list linen-nav-dropdown-list--modules">
                    {EXPLORE_MODULES.map(module => {
                        const current = pathname === module.path
                        return (
                            <li key={module.id}>
                                <Link to={module.path} className={current ? 'is-active' : undefined} aria-current={current ? 'page' : undefined}>
                                    <span>{module.title}</span>
                                    <small>{module.summary}</small>
                                </Link>
                            </li>
                        )
                    })}
                </ul>
            </NavDropdown>
        </>
    )
}
