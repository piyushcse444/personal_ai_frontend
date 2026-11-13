const configuredApiBaseUrl = import.meta.env.VITE_API_BASE_URL

if (!configuredApiBaseUrl) {
  throw new Error('VITE_API_BASE_URL is not configured. Set it in the project .env file.')
}

export const API_BASE_URL = configuredApiBaseUrl.replace(/\/+$/, '')
