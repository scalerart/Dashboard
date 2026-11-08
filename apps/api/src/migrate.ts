import mongoose from 'mongoose'
import { connectDatabase } from './db.js'
import { prepareTenantDatabase } from './tenant-migration.js'

try {
  await connectDatabase()
  await prepareTenantDatabase()
  console.info('Tenant migration and index synchronization completed.')
} catch (error) {
  const message = error instanceof Error ? error.message.replace(/mongodb(?:\+srv)?:\/\/\S+/gi, '[database URI redacted]') : 'Unknown migration error.'
  console.error('Tenant migration failed.', message)
  process.exitCode = 1
} finally {
  await mongoose.disconnect()
}
