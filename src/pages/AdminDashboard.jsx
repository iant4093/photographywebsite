import { Link } from 'react-router-dom'

// Admin dashboard — hub with widget cards for Upload, Manage, and Add Users
function AdminDashboard() {
    // Widget data for the three admin actions
    const widgets = [
        {
            title: 'Upload Photos',
            description: 'Create a new album and upload photos to the main gallery or a specific user.',
            icon: (
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
            ),
            link: '/admin/upload',
            color: 'from-amber to-amber-dark',
        },
        {
            title: 'Manage Albums',
            description: 'Edit, delete, and manage photos across all albums and users.',
            icon: (
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
            ),
            link: '/admin/manage',
            color: 'from-charcoal to-charcoal-light',
        },
        {
            title: 'Manage Users',
            description: 'Add, edit, or remove user accounts and manage their access.',
            icon: (
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
            ),
            link: '/admin/users',
            color: 'from-green-500 to-green-600',
        },
    ]

    return (
        <div className="max-w-5xl mx-auto px-6 py-12">
            <div className="animate-slide-up">
                {/* Header */}
                <div className="mb-10">
                    <h1 className="font-serif text-4xl font-semibold text-charcoal">
                        Admin Dashboard
                    </h1>
                    <p className="mt-2 text-warm-gray">
                        Manage your photography portfolio from here.
                    </p>
                </div>

                {/* Widget grid */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {widgets.map((widget) => (
                        <Link
                            key={widget.title}
                            to={widget.link}
                            className="group block bg-white rounded-2xl p-6 shadow-warm hover:shadow-warm-lg transition-all duration-500 border border-warm-border hover:border-amber/30"
                        >
                            {/* Icon circle */}
                            <div className={`w-14 h-14 rounded-xl bg-gradient-to-br ${widget.color} flex items-center justify-center text-white shadow-warm-sm group-hover:shadow-warm transition-shadow duration-300 mb-5`}>
                                {widget.icon}
                            </div>
                            {/* Text */}
                            <h2 className="font-serif text-xl font-semibold text-charcoal group-hover:text-amber-dark transition-colors duration-300">
                                {widget.title}
                            </h2>
                            <p className="mt-2 text-sm text-warm-gray leading-relaxed">
                                {widget.description}
                            </p>
                            {/* Arrow */}
                            <div className="mt-4 flex items-center gap-1 text-sm font-medium text-amber opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                                Open
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                </svg>
                            </div>
                        </Link>
                    ))}
                </div>
            </div>
        </div>
    )
}

export default AdminDashboard
