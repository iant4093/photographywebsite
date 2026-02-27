import { Routes, Route } from 'react-router-dom'
import Navbar from './components/Navbar'
import Footer from './components/Footer'
import ProtectedRoute from './components/ProtectedRoute'
import Home from './pages/Home'
import AlbumGallery from './pages/AlbumGallery'
import SharedAlbum from './pages/SharedAlbum'
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

// Main app shell with routing
function App() {
  return (
    <div className="min-h-screen flex flex-col bg-cream">
      <Navbar />

      <main className="flex-1">
        <Routes>
          {/* Public routes */}
          <Route path="/" element={<Home />} />
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
      </main>

      <Footer />
    </div>
  )
}

export default App
