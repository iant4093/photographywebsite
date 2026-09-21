import { lazy, Suspense, useEffect, useState } from 'react'
import { Route, Routes, useLocation } from 'react-router'
import Navbar from './components/Navbar'
import Footer from './components/Footer'
import ProtectedRoute from './components/ProtectedRoute'
import BackToTop from './components/BackToTop'
import DocumentMetadata from './components/DocumentMetadata'
import AnalyticsTracker from './components/AnalyticsTracker'
import Home from './pages/Home'
import RouteScrollRestoration from './components/RouteScrollRestoration'
import { loadAlbumGalleryRoute, loadVideoGalleryRoute } from './utils/routePreload'
import { applyDocumentTheme, readStoredTheme, storeTheme } from './utils/theme'

const AlbumGallery = lazy(loadAlbumGalleryRoute)
const CameraCursor = lazy(() => import('./components/CameraCursor'))
const MotionExperience = lazy(() => import('./components/MotionExperience'))
const MistyEcho = lazy(() => import('./components/MistyEcho').catch(() => ({ default: () => null })))
const Search = lazy(() => import('./pages/Search'))
const Explore = lazy(() => import('./pages/Explore'))
const Editor = lazy(() => import('./pages/Editor'))
const Stats = lazy(() => import('./pages/Stats'))
const SharedAlbum = lazy(() => import('./pages/SharedAlbum'))
const Contact = lazy(() => import('./pages/Contact'))
const Privacy = lazy(() => import('./pages/Privacy'))
const Terms = lazy(() => import('./pages/Terms'))
const PrintPolicy = lazy(() => import('./pages/PrintPolicy'))
const Accessibility = lazy(() => import('./pages/Accessibility'))
const Licenses = lazy(() => import('./pages/Licenses'))
const Login = lazy(() => import('./pages/Login'))
const AdminDashboard = lazy(() => import('./pages/AdminDashboard'))
const AwsCosts = lazy(() => import('./pages/AwsCosts'))
const Analytics = lazy(() => import('./pages/Analytics'))
const GoogleDriveUsage = lazy(() => import('./pages/GoogleDriveUsage'))
const GitHubAnalytics = lazy(() => import('./pages/GitHubAnalytics'))
const SiteHealth = lazy(() => import('./pages/SiteHealth'))
const AuditLog = lazy(() => import('./pages/AuditLog'))
const AdminSecurity = lazy(() => import('./pages/AdminSecurity'))
const Upload = lazy(() => import('./pages/Admin'))
const UploadVideo = lazy(() => import('./pages/UploadVideo'))
const ManageHero = lazy(() => import('./pages/ManageHero'))
const ManageAlbums = lazy(() => import('./pages/ManageAlbums'))
const ManageUsers = lazy(() => import('./pages/ManageUsers'))
const AddUser = lazy(() => import('./pages/AddUser'))
const DeleteUser = lazy(() => import('./pages/DeleteUser'))
const EditUser = lazy(() => import('./pages/EditUser'))
const UserDashboard = lazy(() => import('./pages/UserDashboard'))
const NotFound = lazy(() => import('./pages/NotFound'))
const VideoGallery = lazy(loadVideoGalleryRoute)
const Videos = lazy(() => import('./pages/Videos'))
const SectionAlbums = lazy(() => import('./pages/SectionAlbums'))

if (typeof window !== 'undefined') window.history.scrollRestoration = 'manual'

function PageLoading() {
    return (
        <div className="flex min-h-[60vh] items-center justify-center pt-[88px]" role="status" data-route-loading="">
            <span className="sr-only">Loading page</span>
            <div className="h-10 w-10 animate-spin rounded-full border-3 border-amber border-t-transparent" />
        </div>
    )
}

function App() {
    const location = useLocation()
    const isAdminRoute = location.pathname.startsWith('/admin')
    const isImmersiveRoute = location.pathname === '/explore/immersive-gallery'
    const [preferredTheme, setPreferredTheme] = useState(readStoredTheme)
    const theme = preferredTheme

    useEffect(() => {
        applyDocumentTheme(theme)
    }, [theme])

    const toggleTheme = () => {
        const nextTheme = preferredTheme === 'dark' ? 'light' : 'dark'
        setPreferredTheme(nextTheme)
        storeTheme(nextTheme)
        applyDocumentTheme(nextTheme)
    }

    return (
        <div data-theme={theme} className={`linen-site ${isAdminRoute ? 'linen-admin' : ''} ${isImmersiveRoute ? 'linen-immersive' : ''} min-h-screen flex flex-col bg-cream`}>
            <RouteScrollRestoration />
            <DocumentMetadata />
            <AnalyticsTracker />
            <Suspense fallback={null}><CameraCursor enabled={!isImmersiveRoute} routeKey={location.pathname} /></Suspense>
            {!isImmersiveRoute && <a className="linen-skip-link" href="#main-content">Skip to main content</a>}
            {!isImmersiveRoute && (
                <Navbar
                    theme={theme}
                    onToggleTheme={toggleTheme}
                    showThemeToggle
                />
            )}
            <main id="main-content" tabIndex={-1} className="flex-1">
                <Suspense fallback={<PageLoading />}>
                    <Routes location={location}>
                        <Route path="/" element={<Home />} />
                        <Route path="/videos" element={<Videos />} />
                        <Route path="/sections/:mediaType/:category" element={<SectionAlbums />} />
                        <Route path="/search" element={<Search />} />
                        <Route path="/explore/*" element={<Explore />} />
                        <Route path="/editor" element={<Editor />} />
                        <Route path="/stats" element={<Stats />} />
                        <Route path="/album/:albumId" element={<AlbumGallery />} />
                        <Route path="/video/:albumId" element={<VideoGallery />} />
                        <Route path="/sharedalbum" element={<SharedAlbum />} />
                        <Route path="/sharedalbum/:code" element={<SharedAlbum />} />
                        <Route path="/contact" element={<Contact />} />
                        <Route path="/privacy" element={<Privacy />} />
                        <Route path="/terms" element={<Terms />} />
                        <Route path="/print-policy" element={<PrintPolicy />} />
                        <Route path="/accessibility" element={<Accessibility />} />
                        <Route path="/licenses" element={<Licenses />} />
                        <Route path="/login" element={<Login />} />

                        <Route path="/admin" element={<ProtectedRoute adminOnly><AdminDashboard /></ProtectedRoute>} />
                        <Route path="/admin/security" element={<ProtectedRoute adminOnly allowMfaSetup><AdminSecurity /></ProtectedRoute>} />
                        <Route path="/admin/costs" element={<ProtectedRoute adminOnly><AwsCosts /></ProtectedRoute>} />
                        <Route path="/admin/analytics" element={<ProtectedRoute adminOnly><Analytics /></ProtectedRoute>} />
                        <Route path="/admin/drive-usage" element={<ProtectedRoute adminOnly><GoogleDriveUsage /></ProtectedRoute>} />
                        <Route path="/admin/github-analytics" element={<ProtectedRoute adminOnly><GitHubAnalytics /></ProtectedRoute>} />
                        <Route path="/admin/site-health" element={<ProtectedRoute adminOnly><SiteHealth /></ProtectedRoute>} />
                        <Route path="/admin/audit-log" element={<ProtectedRoute adminOnly><AuditLog /></ProtectedRoute>} />
                        <Route path="/admin/upload" element={<ProtectedRoute adminOnly><Upload /></ProtectedRoute>} />
                        <Route path="/admin/upload-video" element={<ProtectedRoute adminOnly><UploadVideo /></ProtectedRoute>} />
                        <Route path="/admin/hero" element={<ProtectedRoute adminOnly><ManageHero /></ProtectedRoute>} />
                        <Route path="/admin/manage" element={<ProtectedRoute adminOnly><ManageAlbums /></ProtectedRoute>} />
                        <Route path="/admin/users" element={<ProtectedRoute adminOnly><ManageUsers /></ProtectedRoute>} />
                        <Route path="/admin/users/add" element={<ProtectedRoute adminOnly><AddUser /></ProtectedRoute>} />
                        <Route path="/admin/users/delete" element={<ProtectedRoute adminOnly><DeleteUser /></ProtectedRoute>} />
                        <Route path="/admin/users/edit" element={<ProtectedRoute adminOnly><EditUser /></ProtectedRoute>} />
                        <Route path="/dashboard" element={<ProtectedRoute><UserDashboard /></ProtectedRoute>} />
                        <Route path="*" element={<NotFound />} />
                    </Routes>
                </Suspense>
            </main>
            {!isImmersiveRoute && <BackToTop />}
            {!isImmersiveRoute && <Footer />}
            <Suspense fallback={null}><MistyEcho key={location.pathname} /></Suspense>
            {!isImmersiveRoute && <Suspense fallback={null}><MotionExperience /></Suspense>}
        </div>
    )
}

export default App
