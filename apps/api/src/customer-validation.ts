import { z } from 'zod'

export const customerInputSchema = z.object({
  name: z.string().trim().min(2).max(160),
  phone: z.string().trim().max(40).default(''),
  email: z.string().trim().email().max(254).or(z.literal('')).default(''),
  address: z.string().trim().max(500).default(''),
})

export const customerStatusSchema = z.object({
  status: z.enum(['active', 'inactive']),
})

export const customerQuerySchema = z.object({
  search: z.string().trim().max(120).default(''),
  status: z.enum(['active', 'inactive', 'all']).default('active'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
})

export function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
