import { lazy, Suspense, useEffect } from 'react'
import { Route, Routes, useLocation, useNavigationType } from 'react-router'
import Navbar from './components/Navbar'
import Footer from './components/Footer'
import ProtectedRoute from './components/ProtectedRoute'
import BackToTop from './components/BackToTop'
import DocumentMetadata from './components/DocumentMetadata'
import Home from './pages/Home'

const AlbumGallery = lazy(() => import('./pages/AlbumGallery'))
const SharedAlbum = lazy(() => import('./pages/SharedAlbum'))
const Contact = lazy(() => import('./pages/Contact'))
const Privacy = lazy(() => import('./pages/Privacy'))
const Login = lazy(() => import('./pages/Login'))
const AdminDashboard = lazy(() => import('./pages/AdminDashboard'))
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
const VideoGallery = lazy(() => import('./pages/VideoGallery'))
const Videos = lazy(() => import('./pages/Videos'))

if (typeof window !== 'undefined') window.history.scrollRestoration = 'manual'

function PageLoading() {
    return (
        <div className="flex min-h-[60vh] items-center justify-center pt-[88px]" role="status" aria-live="polite">
            <span className="sr-only">Loading page</span>
            <div className="h-10 w-10 animate-spin rounded-full border-3 border-amber border-t-transparent" />
        </div>
    )
}

function App() {
    const location = useLocation()
    const navigationType = useNavigationType()

    useEffect(() => {
        if (navigationType !== 'POP') window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
    }, [location.pathname, navigationType])

    return (
        <div className="min-h-screen flex flex-col bg-cream">
            <DocumentMetadata />
            <Navbar />
            <main className="flex-1">
                <Suspense fallback={<PageLoading />}>
                    <Routes location={location}>
                        <Route path="/" element={<Home />} />
                        <Route path="/videos" element={<Videos />} />
                        <Route path="/album/:albumId" element={<AlbumGallery />} />
                        <Route path="/video/:albumId" element={<VideoGallery />} />
                        <Route path="/sharedalbum" element={<SharedAlbum />} />
                        <Route path="/sharedalbum/:code" element={<SharedAlbum />} />
                        <Route path="/contact" element={<Contact />} />
                        <Route path="/privacy" element={<Privacy />} />
                        <Route path="/login" element={<Login />} />

                        <Route path="/admin" element={<ProtectedRoute adminOnly><AdminDashboard /></ProtectedRoute>} />
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
            <BackToTop />
            <Footer />
        </div>
    )
}

export default App
