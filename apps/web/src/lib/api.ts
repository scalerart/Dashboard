import { useQuery as useTanstackQuery } from '@tanstack/react-query'

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? '/api'

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
    this.name = 'ApiError'
  }
}

type QueryOptions = {
  queryKey: readonly unknown[]
  path: string
  params?: Record<string, string>
  retry?: boolean | number
  enabled?: boolean
  refetchInterval?: number | false
  refetchOnWindowFocus?: boolean
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { message?: string } | null
    throw new ApiError(body?.message ?? `Request failed (${response.status}).`, response.status)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

async function requestBlob(path: string): Promise<Blob> {
  const response = await fetch(`${apiBaseUrl}${path}`, { credentials: 'include' })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { message?: string } | null
    throw new ApiError(body?.message ?? `Request failed (${response.status}).`, response.status)
  }
  return response.blob()
}

async function upload<T>(path: string, body: FormData): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: 'POST',
    body,
    credentials: 'include',
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { message?: string } | null
    throw new ApiError(body?.message ?? `Request failed (${response.status}).`, response.status)
  }
  return response.json() as Promise<T>
}

export const api = {
  useQuery<T>({ queryKey, path, params, retry = 1, enabled = true, refetchInterval, refetchOnWindowFocus = false }: QueryOptions) {
    const query = params ? `?${new URLSearchParams(params)}` : ''
    return useTanstackQuery<T, Error>({
      queryKey,
      queryFn: () => request<T>(`${path}${query}`),
      retry,
      enabled,
      refetchInterval,
      refetchOnWindowFocus,
    })
  },
  get: request,
  getBlob: requestBlob,
  upload,
  post<T = void>(path: string, body: unknown, headers?: Record<string, string>) {
    return request<T>(path, { method: 'POST', body: JSON.stringify(body), headers })
  },
  patch<T>(path: string, body: unknown) {
    return request<T>(path, { method: 'PATCH', body: JSON.stringify(body) })
  },
  delete<T = void>(path: string) {
    return request<T>(path, { method: 'DELETE' })
  },
}
