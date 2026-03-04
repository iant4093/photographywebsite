import { Routes, Route, useLocation, useNavigationType } from 'react-router-dom'
import { AnimatePresence } from 'framer-motion'
import { useEffect, useLayoutEffect, useRef } from 'react'
import Navbar from './components/Navbar'
import Footer from './components/Footer'
import ProtectedRoute from './components/ProtectedRoute'
import Home from './pages/Home'
import AlbumGallery from './pages/AlbumGallery'
import SharedAlbum from './pages/SharedAlbum'
import BackToTop from './components/BackToTop'
import Contact from './pages/Contact'
import Login from './pages/Login'
import AdminDashboard from './pages/AdminDashboard'
import Upload from './pages/Admin'
import UploadVideo from './pages/UploadVideo'
import ManageAlbums from './pages/ManageAlbums'
import ManageUsers from './pages/ManageUsers'
import AddUser from './pages/AddUser'
import DeleteUser from './pages/DeleteUser'
import EditUser from './pages/EditUser'
import UserDashboard from './pages/UserDashboard'
import NotFound from './pages/NotFound'
import VideoGallery from './pages/VideoGallery'
import Videos from './pages/Videos'

// Set scroll restoration to manual globally to prevent browser interference with animations
if (typeof window !== 'undefined') {
  window.history.scrollRestoration = 'manual'
}

// Main app shell with routing
function App() {
  const location = useLocation()
  const navType = useNavigationType()
  const scrollPositions = useRef(new Map())

  // Save scroll position on every scroll
  useEffect(() => {
    const handleScroll = () => {
      scrollPositions.current.set(window.location.pathname, window.scrollY)
    }
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  // Execute scroll adjustment only after the outgoing page has completely faded out
  const handleExitComplete = () => {
    if (navType === 'POP') {
      const savedPosition = scrollPositions.current.get(location.pathname)
      if (savedPosition !== undefined) {
        window.scrollTo({ top: savedPosition, left: 0, behavior: 'instant' })
      } else {
        window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
      }
    } else {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
    }
  }

  // Pages that intentionally render their hero image underneath the transparent navbar
  const isHeroPage = location.pathname === '/' || location.pathname === '/videos'

  return (
    <div className="min-h-screen flex flex-col bg-cream">
      <Navbar />

      <main className={`flex-1 ${!isHeroPage ? 'pt-[88px] md:pt-[104px]' : ''}`}>
        <AnimatePresence mode="wait" onExitComplete={handleExitComplete}>
          <Routes location={location} key={location.pathname}>
            {/* Public routes */}
            <Route path="/" element={<Home />} />
            <Route path="/videos" element={<Videos />} />
            <Route path="/album/:albumId" element={<AlbumGallery />} />
            <Route path="/video/:albumId" element={<VideoGallery />} />
            <Route path="/sharedalbum" element={<SharedAlbum />} />
            <Route path="/sharedalbum/:code" element={<SharedAlbum />} />
            <Route path="/contact" element={<Contact />} />
            <Route path="/login" element={<Login />} />

            {/* Admin routes */}
            <Route path="/admin" element={<ProtectedRoute adminOnly><AdminDashboard /></ProtectedRoute>} />
            <Route path="/admin/upload" element={<ProtectedRoute adminOnly><Upload /></ProtectedRoute>} />
            <Route path="/admin/upload-video" element={<ProtectedRoute adminOnly><UploadVideo /></ProtectedRoute>} />
            <Route path="/admin/manage" element={<ProtectedRoute adminOnly><ManageAlbums /></ProtectedRoute>} />
            <Route path="/admin/users" element={<ProtectedRoute adminOnly><ManageUsers /></ProtectedRoute>} />
            <Route path="/admin/users/add" element={<ProtectedRoute adminOnly><AddUser /></ProtectedRoute>} />
            <Route path="/admin/users/delete" element={<ProtectedRoute adminOnly><DeleteUser /></ProtectedRoute>} />
            <Route path="/admin/users/edit" element={<ProtectedRoute adminOnly><EditUser /></ProtectedRoute>} />

            {/* User route */}
            <Route path="/dashboard" element={<ProtectedRoute><UserDashboard /></ProtectedRoute>} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AnimatePresence>
      </main>

      <BackToTop />
      <Footer />
    </div>
  )
}

export default App
