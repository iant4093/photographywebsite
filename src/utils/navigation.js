export function navigateBackOr(navigate, fallback) {
    const historyIndex = Number(globalThis.window?.history?.state?.idx)
    if (Number.isInteger(historyIndex) && historyIndex > 0) {
        navigate(-1)
        return
    }
    navigate(fallback)
}
