import { API_BASE_URL } from './config'

const ACCESS_TOKEN_KEY = 'personAi.accessToken'
const REFRESH_TOKEN_KEY = 'personAi.refreshToken'
let refreshRequest

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

export function getAccessToken(body) {
  if (typeof body === 'string') {
    const token = body.trim()
    return token.split('.').length === 3 ? token : null
  }

  if (!body || typeof body !== 'object') return null

  const token = body.accessToken || body.access_token || body.token || body.jwt
  if (typeof token === 'string' && token.trim()) return token.trim()
  return body.data ? getAccessToken(body.data) : null
}

export function getRefreshToken(body) {
  if (!body || typeof body !== 'object') return null
  const token = body.refreshToken || body.refresh_token
  if (typeof token === 'string' && token.trim()) return token.trim()
  return body.data ? getRefreshToken(body.data) : null
}

export function getDisplayNameFromToken(token) {
  try {
    const payload = token.split('.')[1]
    if (!payload) return 'Explorer'

    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const bytes = Uint8Array.from(window.atob(base64), (character) => character.charCodeAt(0))
    const claims = JSON.parse(new TextDecoder().decode(bytes))
    const name = claims.displayName || claims.name || claims.preferred_username || claims.username || claims.email

    return typeof name === 'string' && name.trim() ? name.trim() : 'Explorer'
  } catch {
    return 'Explorer'
  }
}

export function readAccessToken() {
  try {
    return window.sessionStorage.getItem(ACCESS_TOKEN_KEY)
  } catch {
    return null
  }
}

export function readRefreshToken() {
  try {
    return window.sessionStorage.getItem(REFRESH_TOKEN_KEY)
  } catch {
    return null
  }
}

export function saveTokens(accessToken, refreshToken) {
  try {
    window.sessionStorage.setItem(ACCESS_TOKEN_KEY, accessToken)
    if (refreshToken) window.sessionStorage.setItem(REFRESH_TOKEN_KEY, refreshToken)
    else window.sessionStorage.removeItem(REFRESH_TOKEN_KEY)
  } catch (error) {
    clearTokens()
    throw error
  }
}

export function clearTokens() {
  window.sessionStorage.removeItem(ACCESS_TOKEN_KEY)
  window.sessionStorage.removeItem(REFRESH_TOKEN_KEY)
}

async function readResponse(response) {
  const text = await response.text()
  if (!text) return null

  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function messageFromBody(body, fallback) {
  if (typeof body === 'string' && body.trim()) return body
  if (Array.isArray(body)) {
    const messages = body
      .map((error) => error?.defaultMessage || error?.message)
      .filter(Boolean)
    if (messages.length) return messages.join(' ')
  }

  if (body && typeof body === 'object') {
    if (typeof body.message === 'string') return body.message
    if (typeof body.detail === 'string') return body.detail
    if (Array.isArray(body.errors)) {
      const messages = body.errors
        .map((error) => error.defaultMessage || error.message)
        .filter(Boolean)
      if (messages.length) return messages.join(' ')
    }
  }
  return fallback
}

function apiUrl(path) {
  return `${API_BASE_URL}/api/${path.replace(/^\/+/, '')}`
}

async function refreshAccessToken() {
  if (!refreshRequest) {
    refreshRequest = (async () => {
      const refreshToken = readRefreshToken()
      const response = await fetch(apiUrl('auth/refresh'), {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          ...(refreshToken ? { 'Content-Type': 'application/json' } : {}),
        },
        credentials: 'include',
        ...(refreshToken ? { body: JSON.stringify({ refreshToken }) } : {}),
      })
      const body = await readResponse(response)
      if (!response.ok) {
        throw new ApiError(messageFromBody(body, `Session refresh failed (HTTP ${response.status}).`), response.status, body)
      }

      const accessToken = getAccessToken(body)
      if (!accessToken) throw new Error('Refresh succeeded but no access token was returned.')
      saveTokens(accessToken, getRefreshToken(body) || refreshToken)
      return accessToken
    })()
  }

  try {
    return await refreshRequest
  } finally {
    refreshRequest = null
  }
}

export async function apiRequest(path, options = {}, retry = true) {
  const accessToken = readAccessToken()
  const headers = new Headers(options.headers || {})
  headers.set('Accept', 'application/json')
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)

  let response
  try {
    response = await fetch(apiUrl(path), {
      ...options,
      headers,
      credentials: options.credentials || 'same-origin',
    })
  } catch (error) {
    const method = options.method || 'GET'
    const url = apiUrl(path)
    throw new Error(
      `The browser could not complete ${method} ${url}. Check that the backend is running and its CORS policy allows origin ${window.location.origin}, method ${method}, and headers Authorization and Content-Type. ${error.message}`,
    )
  }

  if (response.status === 401 && retry && !path.replace(/^\/+/, '').startsWith('auth/')) {
    try {
      await refreshAccessToken()
      return apiRequest(path, options, false)
    } catch (error) {
      clearTokens()
      window.dispatchEvent(new Event('personAi.sessionExpired'))
      throw new ApiError(`Your session expired. Sign in again. ${error.message}`, 401)
    }
  }

  const body = await readResponse(response)
  if (!response.ok) {
    throw new ApiError(messageFromBody(body, `Request failed (HTTP ${response.status}).`), response.status, body)
  }
  return body
}

export function apiGet(path) {
  return apiRequest(path)
}

export function apiPost(path, payload, options = {}) {
  return apiRequest(path, {
    ...options,
    method: 'POST',
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  })
}

export function apiPatch(path, payload) {
  return apiRequest(path, { method: 'PATCH', body: JSON.stringify(payload) })
}

export function apiDelete(path) {
  return apiRequest(path, { method: 'DELETE' })
}

export function getItems(body, preferredKeys = []) {
  if (Array.isArray(body)) return body
  if (!body || typeof body !== 'object') return []

  for (const key of [...preferredKeys, 'items', 'content', 'results', 'records']) {
    if (Array.isArray(body[key])) return body[key]
  }

  return body.data && body.data !== body ? getItems(body.data, preferredKeys) : []
}

export function getEntity(body, preferredKeys = []) {
  if (!body || typeof body !== 'object') return body
  for (const key of preferredKeys) {
    if (body[key] && typeof body[key] === 'object') return body[key]
  }
  if (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) {
    return getEntity(body.data, preferredKeys)
  }
  return body
}

export function getEntityId(entity, fallbackKeys = []) {
  if (!entity || typeof entity !== 'object') return ''
  const id = entity.id || fallbackKeys.map((key) => entity[key]).find(Boolean)
  return id === undefined || id === null ? '' : String(id)
}

export function getEntityName(entity, fallback = 'Untitled') {
  if (!entity || typeof entity !== 'object') return fallback
  return entity.name || entity.configName || entity.config_name || entity.displayName || entity.title || entity.modelName || entity.providerName || fallback
}

export function getMessageContent(entity) {
  if (!entity || typeof entity !== 'object') return ''
  return entity.content || entity.message || entity.text || ''
}
