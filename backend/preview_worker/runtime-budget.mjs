import { AsyncLocalStorage } from 'node:async_hooks'

const budget = new AsyncLocalStorage()
export const workerClientConfig = {
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 2000, socketTimeout: 15000, requestTimeout: 30000, throwOnRequestTimeout: true },
}

export function withWorkerBudget(context, operation) {
    const remaining = context?.getRemainingTimeInMillis?.() ?? context?.get_remaining_time_in_millis?.() ?? 180000
    const controller = new AbortController()
    const duration = Math.max(1, remaining - 3000)
    const timer = setTimeout(() => controller.abort(new Error('Preview processing deadline reached')), duration)
    return budget.run({ deadline: performance.now() + duration, signal: controller.signal }, async () => {
        try { return await operation() }
        finally { clearTimeout(timer) }
    })
}

export function workerTimeRemaining() {
    const current = budget.getStore()
    return current ? Math.max(0, current.deadline - performance.now() + 3000) : 180000
}

export function hasWorkerTime(minimumMs = 0) {
    const current = budget.getStore()
    return !current || (!current.signal.aborted && current.deadline - performance.now() > minimumMs)
}

export function checkWorkerTime() {
    if (!hasWorkerTime()) throw new Error('Preview processing deadline reached')
}

export function boundedClient(client) {
    return {
        async send(command, options = {}) {
            checkWorkerTime()
            const signal = budget.getStore()?.signal
            const result = await client.send(command, { ...options, ...(signal ? { abortSignal: signal } : {}) })
            checkWorkerTime()
            return result
        },
    }
}

// Native transforms and response-body readers can outlive an SDK request.
// Return the record to SQS before Lambda's hard timeout; the aborted context
// also prevents an abandoned continuation from starting any later AWS writes.
export async function runWorkerJob(operation) {
    checkWorkerTime()
    const signal = budget.getStore()?.signal
    if (!signal) return operation()
    let stop
    const interrupted = new Promise((_, reject) => {
        stop = () => reject(signal.reason)
        signal.addEventListener('abort', stop, { once: true })
    })
    try { return await Promise.race([Promise.resolve().then(operation), interrupted]) }
    finally { signal.removeEventListener('abort', stop) }
}
