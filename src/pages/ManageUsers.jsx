import { Link } from 'react-router-dom'

// Manage Users hub — 3 widget cards for Add, Delete, Edit users
function ManageUsers() {
    const widgets = [
        {
            title: 'Add User',
            description: 'Create a new viewer account so a client can access their private photos.',
            icon: (
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
                </svg>
            ),
            link: '/admin/users/add',
            color: 'from-green-500 to-green-600',
        },
        {
            title: 'Edit User',
            description: 'Change a user\'s email or password. Their albums will remain accessible.',
            icon: (
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
            ),
            link: '/admin/users/edit',
            color: 'from-amber to-amber-dark',
        },
        {
            title: 'Delete User',
            description: 'Permanently remove a user and all their albums and photos.',
            icon: (
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
            ),
            link: '/admin/users/delete',
            color: 'from-red-500 to-red-600',
        },
    ]

    return (
        <div className="max-w-5xl mx-auto px-6 py-12">
            <div className="animate-slide-up">
                {/* Back link */}
                <Link to="/admin" className="inline-flex items-center gap-2 text-sm font-medium text-warm-gray hover:text-amber transition-colors duration-200 mb-8">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                    Back to Dashboard
                </Link>

                <div className="mb-10">
                    <h1 className="font-serif text-4xl font-semibold text-charcoal">Manage Users</h1>
                    <p className="mt-2 text-warm-gray">Add, edit, or remove user accounts.</p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {widgets.map((widget) => (
                        <Link
                            key={widget.title}
                            to={widget.link}
                            className="group block bg-white rounded-2xl p-6 shadow-warm hover:shadow-warm-lg transition-all duration-500 border border-warm-border hover:border-amber/30"
                        >
                            <div className={`w-14 h-14 rounded-xl bg-gradient-to-br ${widget.color} flex items-center justify-center text-white shadow-warm-sm group-hover:shadow-warm transition-shadow duration-300 mb-5`}>
                                {widget.icon}
                            </div>
                            <h2 className="font-serif text-xl font-semibold text-charcoal group-hover:text-amber-dark transition-colors duration-300">
                                {widget.title}
                            </h2>
                            <p className="mt-2 text-sm text-warm-gray leading-relaxed">
                                {widget.description}
                            </p>
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

export default ManageUsers
