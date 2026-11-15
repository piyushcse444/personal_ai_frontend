const configuredApiBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim()
const hostname = window.location.hostname
const defaultApiBaseUrl = `${window.location.protocol}//${hostname}:8080`

export const API_BASE_URL = (configuredApiBaseUrl || defaultApiBaseUrl).replace(/\/+$/, '')
