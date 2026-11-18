import { useLayoutEffect, useState } from 'react'
import { Link, useLocation } from 'react-router'
import useNavSections from '../hooks/useNavSections'
import { EXPLORE_MODULES } from '../utils/exploreModules'
import { APP_MODULES } from '../utils/appModules'
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
                                <Link to={to} data-route-card="section" className={current ? 'is-active' : undefined} aria-current={current ? 'page' : undefined}>
                                    <span data-route-title="">{category}</span>
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
export default function NavDropdowns({ pathname, photoActive, videoActive, exploreActive, appsActive }) {
    const { key } = useLocation()
    const [dropdown, setDropdown] = useState(null)
    const photoSections = useNavSections('photo')
    const videoSections = useNavSections('video')
    // Hide a retiring panel before the destination is painted, even if its
    // normal pointer-leave fade had already started on the previous page.
    const changedPage = dropdown && dropdown.key !== key
    if (changedPage && !dropdown.navigationDismissal) {
        setDropdown({ ...dropdown, open: false, navigating: false, navigationDismissal: true })
    }
    useLayoutEffect(() => {
        const holdPanelOnNavigation = event => {
            if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
            const link = event.target.closest?.('.linen-nav a[href]')
            if (!link || link.origin !== window.location.origin || link.hasAttribute('download') || (link.target && link.target !== '_self')) return
            // A lazy route can still be painting the old page after the URL
            // changes. Keep the panel in place until React commits the route.
            setDropdown(current => current?.key === key && current.open ? { ...current, navigating: true } : current)
        }
        document.addEventListener('click', holdPanelOnNavigation, true)
        return () => document.removeEventListener('click', holdPanelOnNavigation, true)
    }, [key])
    const dropdownProps = (id) => ({
        id,
        open: !changedPage && dropdown?.id === id && dropdown.open,
        navigating: Boolean(!changedPage && dropdown?.id === id && dropdown.navigating),
        navigationDismissal: Boolean(changedPage || dropdown?.navigationDismissal),
        onOpen: (next) => {
            if (next === 'photo') photoSections.refresh()
            if (next === 'video') videoSections.refresh()
            setDropdown(current => current?.key === key && current.navigating ? current
                : { id: next, key, open: true, navigating: false, navigationDismissal: false })
        },
        onClose: (closing) => setDropdown(current => current?.id === closing && !current.navigating
            ? { ...current, open: false }
            : current),
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
            <NavDropdown {...dropdownProps('apps')} label="Apps" to="/apps" active={appsActive}>
                <div className="linen-nav-dropdown-head">
                    <span>Apps</span>
                    <Link to="/apps">All apps →</Link>
                </div>
                <ul className="linen-nav-dropdown-list linen-nav-dropdown-list--apps">
                    {APP_MODULES.map(module => {
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
