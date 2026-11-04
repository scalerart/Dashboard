import type { Request, Response } from 'express'
import { app } from './app.js'
import { connectDatabase } from './db.js'
import { initializeFreshTenantDatabase } from './tenant-migration.js'

let initialization: Promise<void> | undefined

function initialize() {
  if (!initialization) {
    initialization = connectDatabase()
      .then(() => initializeFreshTenantDatabase())
      .then(() => undefined)
      .catch((error: unknown) => {
        initialization = undefined
        const errorName = error instanceof Error ? error.name : 'UnknownError'
        console.error('Unable to initialize the Vercel API.', { errorName })
        throw error
      })
  }
  return initialization
}

export async function vercelApiHandler(req: Request, res: Response) {
  try {
    await initialize()
  } catch {
    res.status(503).json({
      message: 'The API database is unavailable or needs its tenant migration. Check the deployment configuration and logs.',
    })
    return
  }
  return new Promise<void>((resolve) => {
    res.once('finish', resolve)
    res.once('close', resolve)
    app(req, res)
  })
}
