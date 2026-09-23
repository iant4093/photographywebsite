import { randomUUID } from 'node:crypto'
import { UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { workerTimeRemaining } from './runtime-budget.mjs'

export async function withMediaLease(client, table, albumId, operation) {
    if (process.env.MEDIA_MUTATION_PROTOCOL === '0') return operation()
    const owner = randomUUID()
    const now = Math.floor(Date.now() / 1000)
    await client.send(new UpdateCommand({
        TableName: table, Key: { albumId },
        UpdateExpression: 'SET mediaLeaseOwner = :owner, mediaLeaseUntil = :until',
        ConditionExpression: 'attribute_exists(albumId) AND (attribute_not_exists(#status) OR #status = :active) AND (attribute_not_exists(mediaLeaseUntil) OR mediaLeaseUntil < :now)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':owner': owner, ':until': now + Math.ceil(workerTimeRemaining() / 1000) + 60, ':now': now, ':active': 'active' },
    }))
    try { return await operation() }
    finally {
        try {
            await client.send(new UpdateCommand({
                TableName: table, Key: { albumId }, UpdateExpression: 'REMOVE mediaLeaseOwner, mediaLeaseUntil',
                ConditionExpression: 'attribute_exists(albumId) AND mediaLeaseOwner = :owner',
                ExpressionAttributeValues: { ':owner': owner },
            }))
        } catch { /* The lease safely expires after this invocation's deadline. */ }
    }
}
