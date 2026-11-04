import cookieParser from 'cookie-parser'
import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import multer from 'multer'
import mongoose from 'mongoose'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ZodError } from 'zod'
import { config } from './config.js'
import { authRouter } from './auth.js'
import { businessRouter } from './business.js'
import { customersRouter } from './customers.js'
import { dashboardRouter } from './dashboard.js'
import { integrationsRouter } from './integrations.js'

export const app = express()
const webDistPath = fileURLToPath(new URL('../../../apps/web/dist/', import.meta.url))
const webIndexPath = join(webDistPath, 'index.html')

if (config.NODE_ENV === 'production' && !existsSync(webIndexPath)) {
  throw new Error('Production web assets are missing. Run the root build command before starting the API.')
}

app.disable('x-powered-by')
app.set('trust proxy', config.TRUST_PROXY_HOPS || false)
app.use(helmet())
app.use(cors({ origin: config.CLIENT_ORIGIN, credentials: true }))
app.use(express.json({ limit: '1mb' }))
app.use(cookieParser())
if (config.NODE_ENV === 'production') {
  app.use(express.static(webDistPath, { index: false }))
}
app.get('/api/health', (_req, res) => {
  const databaseConnected = mongoose.connection.readyState === 1
  res.status(databaseConnected ? 200 : 503).json({
    status: databaseConnected ? 'ok' : 'unavailable',
    database: databaseConnected ? 'connected' : 'disconnected',
  })
})

app.use('/api/auth', authRouter)
app.use('/api/dashboard', dashboardRouter)
app.use('/api/customers', customersRouter)
app.use('/api', businessRouter)
app.use('/api', integrationsRouter)

app.use('/api', (_req, res) => {
  res.status(404).json({ message: 'Route not found.' })
})

if (config.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) {
      next()
      return
    }
    res.sendFile(webIndexPath, (error) => {
      if (error) next(error)
    })
  })
}

app.use((_req, res) => {
  res.status(404).json({ message: 'Route not found.' })
})

app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) {
    next(error)
    return
  }
  if (error instanceof ZodError) {
    res.status(400).json({
      message: 'Please check the submitted information.',
      issues: error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
    })
    return
  }
  if (error instanceof multer.MulterError) {
    res.status(400).json({ message: error.code === 'LIMIT_FILE_SIZE' ? 'File exceeds the 4 MB limit.' : 'The uploaded file was rejected.' })
    return
  }
  if (error instanceof mongoose.Error.ValidationError) {
    res.status(400).json({ message: 'Please check the submitted information.', issues: Object.values(error.errors).map((item) => item.message) })
    return
  }
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
    res.status(409).json({ message: 'A record with the same unique value already exists.' })
    return
  }
  if (typeof error === 'object' && error !== null && 'status' in error && 'message' in error) {
    const status = Number(error.status)
    if (Number.isInteger(status) && status >= 400 && status < 500) {
      res.status(status).json({ message: String(error.message) })
      return
    }
    if (status === 503) {
      res.status(status).json({ message: String(error.message) })
      return
    }
  }
  console.error(error)
  res.status(500).json({ message: 'An unexpected server error occurred.' })
})
