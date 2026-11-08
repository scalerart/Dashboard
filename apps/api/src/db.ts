import mongoose from 'mongoose'
import { config } from './config.js'

let connectionPromise: Promise<typeof mongoose> | undefined

function assertDevelopmentDatabaseIsSafe() {
  if (config.NODE_ENV !== 'development' || config.ALLOW_REMOTE_DEVELOPMENT_DATABASE) return
  const isLocalDatabase = /^mongodb(?:\+srv)?:\/\/(?:[^@/]+@)?(?:localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal)(?=[:/]|$)/i
    .test(config.MONGODB_URI)
  if (!isLocalDatabase) {
    throw new Error('Remote development database access is disabled. Use a disposable local database or explicitly opt in to a dedicated development database.')
  }
}

export async function connectDatabase() {
  assertDevelopmentDatabaseIsSafe()
  if (mongoose.connection.readyState === 1) return mongoose
  if (mongoose.connection.readyState === 2 && connectionPromise) return connectionPromise

  connectionPromise = mongoose.connect(config.MONGODB_URI, {
    serverSelectionTimeoutMS: 10_000,
    maxPoolSize: 10,
    maxIdleTimeMS: 30_000,
    autoIndex: false,
  }).catch((error: unknown) => {
    connectionPromise = undefined
    throw error
  })
  return connectionPromise
}
