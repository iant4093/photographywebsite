import { Link } from 'react-router'

function DashboardBackLink({ children, ...props }) {
    return (
        <Link to="/admin" state={{ restoreDashboardScroll: true }} {...props}>
            {children}
        </Link>
    )
}

export default DashboardBackLink
