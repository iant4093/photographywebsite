import { Link } from 'react-router-dom'

export default function NotFound() {
    return (
        <div className="flex flex-col items-center justify-center min-h-[60vh] px-4 text-center">
            <h1 className="text-5xl font-light text-black mb-4 tracking-tight">404</h1>
            <p className="text-xl text-gray-600 mb-8 font-light">
                The page you are looking for doesn't exist.
            </p>
            <Link
                to="/"
                className="px-6 py-3 bg-black text-white hover:bg-gray-800 transition-colors uppercase tracking-widest text-sm"
            >
                Return Home
            </Link>
        </div>
    )
}
