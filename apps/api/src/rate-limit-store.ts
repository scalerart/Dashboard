import { createHash } from 'node:crypto'
import type { ClientRateLimitInfo, Options, Store } from 'express-rate-limit'
import type { Document } from 'mongodb'
import mongoose from 'mongoose'

type RateLimitBucket = Document & {
  _id: string
  totalHits: number
  expiresAt: Date
}

function isDuplicateKeyError(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000
}

export class MongoRateLimitStore implements Store {
  localKeys = false
  private windowMs = 15 * 60 * 1000

  init(options: Options) {
    this.windowMs = options.windowMs
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const id = createHash('sha256').update(key).digest('hex')
    const collection = mongoose.connection.collection<RateLimitBucket>('api_rate_limit_buckets')

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const now = new Date()
      const expiresAt = new Date(now.getTime() + this.windowMs)
      const active = await collection.updateOne(
        { _id: id, expiresAt: { $gt: now } },
        { $inc: { totalHits: 1 } },
      )
      if (active.modifiedCount > 0) {
        const bucket = await collection.findOne({ _id: id })
        if (bucket) return { totalHits: bucket.totalHits, resetTime: bucket.expiresAt }
        continue
      }

      const expired = await collection.updateOne(
        { _id: id, expiresAt: { $lte: now } },
        { $set: { totalHits: 1, expiresAt } },
      )
      if (expired.modifiedCount > 0) return { totalHits: 1, resetTime: expiresAt }

      try {
        await collection.insertOne({ _id: id, totalHits: 1, expiresAt })
        return { totalHits: 1, resetTime: expiresAt }
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error
      }
    }

    throw new Error('Unable to update the shared API rate limit counter.')
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const id = createHash('sha256').update(key).digest('hex')
    const bucket = await mongoose.connection
      .collection<RateLimitBucket>('api_rate_limit_buckets')
      .findOne({ _id: id, expiresAt: { $gt: new Date() } })
    return bucket ? { totalHits: bucket.totalHits, resetTime: bucket.expiresAt } : undefined
  }

  async decrement(key: string) {
    const id = createHash('sha256').update(key).digest('hex')
    await mongoose.connection
      .collection<RateLimitBucket>('api_rate_limit_buckets')
      .updateOne({ _id: id, totalHits: { $gt: 0 } }, { $inc: { totalHits: -1 } })
  }

  async resetKey(key: string) {
    const id = createHash('sha256').update(key).digest('hex')
    await mongoose.connection
      .collection<RateLimitBucket>('api_rate_limit_buckets')
      .deleteOne({ _id: id })
  }
}
