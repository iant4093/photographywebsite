import { randomUUID } from 'node:crypto'
import { CreateInvalidationCommand } from '@aws-sdk/client-cloudfront'
import { heroPaths, parseHeroJob } from './hero.mjs'

// A compatible rollback changes this to 'exact', retaining v3 request identities.
export const HERO_INVALIDATION_MODE = 'compact'

export async function invalidateHeroPublication(client, {
    distributionId, job, currentAliases, existingAliases, mode = HERO_INVALIDATION_MODE,
}) {
    const parsed = parseHeroJob(job)
    const paths = heroPaths(parsed.heroType)
    if (!distributionId) throw new Error('Hero invalidation distribution is not configured')
    if (!['compact', 'exact'].includes(mode)) throw new Error('Invalid hero invalidation mode')
    const aliases = [...currentAliases, ...existingAliases]
    if (aliases.some(key => typeof key !== 'string' || !key.startsWith(`${paths.current}/`))) {
        throw new Error('Invalid hero alias namespace')
    }
    const documents = [`/${paths.home}`, `/${paths.manifest}`]
    const exactPaths = [...new Set([...documents, ...aliases.map(key => `/${key}`)])]
    // A content version can be published again after another version. Each
    // publication must purge anew; SDK retries reuse the same command identity.
    const publicationId = randomUUID().replaceAll('-', '')
    const send = (shape, items) => client.send(new CreateInvalidationCommand({
        DistributionId: distributionId,
        InvalidationBatch: {
            CallerReference: `responsive-${parsed.heroType}-hero-v3-${parsed.version}-${publicationId}-${shape}`,
            Paths: { Quantity: items.length, Items: items },
        },
    }))
    if (mode === 'exact') return send('exact', exactPaths)
    try {
        return await send('compact', [...documents, `/${paths.current}/*`])
    } catch (error) {
        // Only an explicit provider rejection permits a different request.
        // Ambiguous acceptance/timeouts must preserve the existing SQS retry.
        if (error?.name !== 'TooManyInvalidationsInProgress' || error?.$metadata?.httpStatusCode !== 400) throw error
        return send('exact', exactPaths)
    }
}
