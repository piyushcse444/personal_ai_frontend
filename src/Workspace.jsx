import { Children, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  ApiError,
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  apiStream,
  clearTokens,
  getDisplayNameFromToken,
  getEntity,
  getEntityId,
  getEntityName,
  getItems,
  getMessageContent,
  readAccessToken,
  readRefreshToken,
} from './api'
import './Workspace.css'

const THINKING_PREFERENCE_KEY = 'personAi.thinkingEnabled'
const INTERNET_PREFERENCE_KEY = 'personAi.internetEnabled'

function readThinkingPreference() {
  try {
    return window.localStorage.getItem(THINKING_PREFERENCE_KEY) !== 'false'
  } catch {
    return true
  }
}

function readInternetPreference() {
  try {
    return window.localStorage.getItem(INTERNET_PREFERENCE_KEY) !== 'false'
  } catch {
    return true
  }
}

function getId(item, keys = []) {
  return getEntityId(item, keys)
}

function getMessageRole(message) {
  const role = String(message?.role || message?.type || message?.sender || '').toLowerCase()
  return role.includes('assistant') || role.includes('ai') ? 'assistant' : 'user'
}

function normalizeMessage(message, index = 0) {
  return {
    ...message,
    id: getId(message, ['messageId']) || `message-${index}`,
    role: getMessageRole(message),
    content: getMessageContent(message),
  }
}

function appendStreamToken(message, content, isThinking) {
  if (isThinking) {
    return { ...message, thinkingContent: `${message.thinkingContent || ''}${content}`, isThinking: true }
  }

  const currentContent = message.content || ''
  if (message.streamPrefixHandled || currentContent) {
    return { ...message, content: `${currentContent}${content}`, isThinking: false }
  }

  const candidate = `${message.streamPrefix || ''}${content}`
  if (candidate === 'null') {
    return { ...message, streamPrefix: '', streamPrefixHandled: true, isThinking: false }
  }
  if ('null'.startsWith(candidate)) {
    return { ...message, streamPrefix: candidate, isThinking: false }
  }
  return {
    ...message,
    content: candidate.startsWith('null') ? candidate.slice(4) : candidate,
    streamPrefix: '',
    streamPrefixHandled: true,
    isThinking: false,
  }
}

function getApiError(error) {
  return error?.message || 'Something went wrong. Please try again.'
}

function getConversationIdFromPath(pathname) {
  const match = pathname.match(/^\/chat\/([^/]+)\/?$/)
  if (!match) return ''

  try {
    return decodeURIComponent(match[1])
  } catch {
    return ''
  }
}

function Icon({ children }) {
  return <span className="workspace-icon" aria-hidden="true">{children}</span>
}

function CodeBlock({ children }) {
  const [copyLabel, setCopyLabel] = useState('Copy')
  const code = Children.toArray(children)
    .map((child) => typeof child === 'string' ? child : child.props?.children || '')
    .join('')

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code)
      setCopyLabel('Copied')
    } catch {
      setCopyLabel('Copy failed')
    }
  }

  return (
    <pre className="markdown-code-block">
      <button className="copy-code-button" type="button" onClick={copyCode}>{copyLabel}</button>
      {children}
    </pre>
  )
}

export default function Workspace({ onLogout }) {
  const [section, setSection] = useState('chat')
  const [user, setUser] = useState(null)
  const [providers, setProviders] = useState([])
  const [models, setModels] = useState([])
  const [configs, setConfigs] = useState([])
  const [conversations, setConversations] = useState([])
  const [resourceErrors, setResourceErrors] = useState({})
  const [notice, setNotice] = useState(null)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [configProviderFilter, setConfigProviderFilter] = useState('')
  const [conversationPage, setConversationPage] = useState(0)
  const [hasMoreConversations, setHasMoreConversations] = useState(false)
  const [activeConversation, setActiveConversation] = useState(null)
  const [messages, setMessages] = useState([])
  const [messagePage, setMessagePage] = useState(0)
  const [hasMoreMessages, setHasMoreMessages] = useState(false)
  const [draft, setDraft] = useState('')
  const [modelId, setModelId] = useState('')
  const [configId, setConfigId] = useState('')
  const [selectedProvider, setSelectedProvider] = useState(null)
  const [selectedModel, setSelectedModel] = useState(null)
  const [selectedConfig, setSelectedConfig] = useState(null)
  const [editingConfigId, setEditingConfigId] = useState('')
  const [configProviderModels, setConfigProviderModels] = useState([])
  const [configProviderModelsLoading, setConfigProviderModelsLoading] = useState(false)
  const [configForm, setConfigForm] = useState({
    providerId: '',
    name: '',
    endpoint: '',
    apiKey: '',
    active: true,
  })
  const [providerForm, setProviderForm] = useState({
    code: '',
    displayName: '',
    providerType: 'CLOUD',
    baseUrl: '',
  })
  const [modelForm, setModelForm] = useState({
    providerId: '',
    modelName: '',
    displayName: '',
    contextWindow: '8192',
  })
  const [conversationTitle, setConversationTitle] = useState('')
  const [editingConversationId, setEditingConversationId] = useState('')
  const [editingConversationTitle, setEditingConversationTitle] = useState('')
  const [profileName, setProfileName] = useState('')
  const [profileEmail, setProfileEmail] = useState('')
  const [pending, setPending] = useState(false)
  const [thinkingEnabled, setThinkingEnabled] = useState(readThinkingPreference)
  const [internetEnabled, setInternetEnabled] = useState(readInternetPreference)
  const [retryRequest, setRetryRequest] = useState(null)
  const [streamingAssistantId, setStreamingAssistantId] = useState('')
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const composerRef = useRef(null)
  const messageThreadRef = useRef(null)
  const shouldStickToBottomRef = useRef(true)
  const streamControllerRef = useRef(null)
  const configProviderModelsRequestRef = useRef(0)
  const userCancelledStreamRef = useRef(false)
  const activeConversationIdRef = useRef('')
  const activeConversationId = getId(activeConversation, ['conversationId'])
  const retryContent = retryRequest?.conversationId === activeConversationId ? retryRequest.content : ''
  const displayName = user?.displayName || user?.name || user?.email || getDisplayNameFromToken(readAccessToken() || '')
  const level = Math.floor(messages.length / 5) + 1

  useLayoutEffect(() => {
    const thread = messageThreadRef.current
    if (thread && shouldStickToBottomRef.current) {
      thread.scrollTop = thread.scrollHeight
    }
  }, [messages, pending])

  const setResourceError = useCallback((key, error) => {
    setResourceErrors((current) => ({ ...current, [key]: error ? getApiError(error) : '' }))
  }, [])
  const loadConversations = useCallback(async (page = 0, search = query) => {
    const params = new URLSearchParams({ page: String(page), size: '10' })
    if (search.trim()) params.set('search', search.trim())
    try {
      const body = await apiGet(`conversations?${params.toString()}`)
      const items = getItems(body, ['conversations'])
      setConversations((current) => page === 0 ? items : [...current, ...items])
      setConversationPage(page)
      const pagination = body?.page || body?.data?.page
      setHasMoreConversations(
        typeof body?.last === 'boolean' ? !body.last
          : typeof pagination?.last === 'boolean' ? !pagination.last
            : items.length === 10,
      )
      setResourceError('conversations', null)
    } catch (error) {
      setResourceError('conversations', error)
    }
  }, [query, setResourceError])

  const loadConfigs = useCallback(async (providerId = configProviderFilter) => {
    const params = new URLSearchParams()
    if (providerId) params.set('providerId', providerId)
    const suffix = params.size ? `?${params.toString()}` : ''
    try {
      const body = await apiGet(`provider-configs${suffix}`)
      setConfigs(getItems(body, ['providerConfigs', 'configs']))
      setResourceError('configs', null)
    } catch (error) {
      setResourceError('configs', error)
    }
  }, [configProviderFilter, setResourceError])

  const loadMessages = useCallback(async (conversationId, page = 0, append = false) => {
    const params = new URLSearchParams({ page: String(page), size: '50' })
    try {
      const body = await apiGet(`conversations/${encodeURIComponent(conversationId)}/messages?${params.toString()}`)
      const items = getItems(body, ['messages'])
      const normalized = items.map((item, index) => normalizeMessage(item, `${page}-${index}`))
        .filter((item) => item.content)
      setMessages((current) => append ? [...current, ...normalized] : normalized)
      setMessagePage(page)
      const pagination = body?.page || body?.data?.page
      setHasMoreMessages(
        typeof body?.last === 'boolean' ? !body.last
          : typeof pagination?.last === 'boolean' ? !pagination.last
            : items.length === 50,
      )
      setResourceError('messages', null)
    } catch (error) {
      setResourceError('messages', error)
    }
  }, [setResourceError])

  const loadConversationDetails = useCallback(async (id) => {
    const details = await apiGet(`conversations/${encodeURIComponent(id)}`)
    const entity = getEntity(details, ['conversation'])
    setActiveConversation(entity)
    setModelId(String(entity.modelId || entity.model?.id || ''))
    setConfigId(String(entity.providerConfigId || entity.providerConfig?.id || ''))
    await loadMessages(id)
    setResourceError('conversationDetail', null)
  }, [loadMessages, setResourceError])

  useEffect(() => {
    let active = true
    async function loadInitialData() {
      const requests = await Promise.allSettled([
        apiGet('users/me'),
        apiGet('providers'),
        apiGet('models'),
        apiGet('provider-configs'),
        apiGet('conversations?page=0&size=10'),
      ])
      if (!active) return

      const [userResult, providerResult, modelResult, configResult, conversationResult] = requests
      if (userResult.status === 'fulfilled') {
        const currentUser = getEntity(userResult.value, ['user'])
        setUser(currentUser)
        setProfileName(currentUser?.displayName || currentUser?.name || '')
        setProfileEmail(currentUser?.email || '')
      } else setResourceError('account', userResult.reason)

      if (providerResult.status === 'fulfilled') setProviders(getItems(providerResult.value, ['providers']))
      else setResourceError('providers', providerResult.reason)

      if (modelResult.status === 'fulfilled') setModels(getItems(modelResult.value, ['models']))
      else setResourceError('models', modelResult.reason)

      if (configResult.status === 'fulfilled') setConfigs(getItems(configResult.value, ['providerConfigs', 'configs']))
      else setResourceError('configs', configResult.reason)

      if (conversationResult.status === 'fulfilled') {
        const items = getItems(conversationResult.value, ['conversations'])
        setConversations(items)
        setHasMoreConversations(items.length === 10)
      } else setResourceError('conversations', conversationResult.reason)

      const conversationId = getConversationIdFromPath(window.location.pathname)
      if (conversationId) {
        try {
          await loadConversationDetails(conversationId)
          setSection('chat')
        } catch (error) {
          setResourceError('conversationDetail', error)
        }
      }
    }
    loadInitialData()
    return () => { active = false }
  }, [loadConversationDetails, setResourceError])

  useEffect(() => {
    async function handleHistoryChange() {
      const conversationId = getConversationIdFromPath(window.location.pathname)
      setSection('chat')
      setNotice(null)
      if (!conversationId) {
        setActiveConversation(null)
        setMessages([])
        setResourceError('conversationDetail', null)
        return
      }

      try {
        await loadConversationDetails(conversationId)
      } catch (error) {
        setResourceError('conversationDetail', error)
      }
    }

    window.addEventListener('popstate', handleHistoryChange)
    return () => window.removeEventListener('popstate', handleHistoryChange)
  }, [loadConversationDetails, setResourceError])

  const filteredModels = useMemo(() => {
    const config = configs.find((item) => getId(item, ['configId', 'providerConfigId']) === configId)
    const providerId = config?.providerId || config?.provider?.id
    return providerId
      ? models.filter((model) => String(model.providerId || model.provider?.id) === String(providerId))
      : models
  }, [configs, configId, models])
  const selectedCatalogModel = models.find((model) => getId(model, ['modelId']) === modelId)
  const selectedModelIsOffline = selectedCatalogModel?.isOffline === true
    || (getId(selectedModel, ['modelId']) === modelId && selectedModel?.isOffline === true)
  const configProviderIsOffline = configProviderModels.length > 0
    && configProviderModels.every((model) => model.isOffline === true)

  useEffect(() => {
    if (configId) {
      const config = configs.find((item) => getId(item, ['configId', 'providerConfigId']) === configId)
      const providerId = config?.providerId || config?.provider?.id
      if (providerId) {
        apiGet(`models?providerId=${encodeURIComponent(providerId)}`)
          .then((body) => {
            const filtered = getItems(body, ['models'])
            if (filtered.length) setModels((current) => [
              ...current.filter((model) => String(model.providerId || model.provider?.id) !== String(providerId)),
              ...filtered.map((model) => ({ ...model, providerId: model.providerId || providerId })),
            ])
            setResourceError('modelsByProvider', null)
          })
          .catch((error) => setResourceError('modelsByProvider', error))
      }
    }
  }, [configId, configs, setResourceError])

  useEffect(() => {
    if (!modelId) return
    apiGet(`models/${encodeURIComponent(modelId)}`)
      .then((body) => {
        setSelectedModel(getEntity(body, ['model']))
        setResourceError('modelDetail', null)
      })
      .catch((error) => setResourceError('modelDetail', error))
  }, [modelId, setResourceError])

  async function openConversation(conversation) {
    const id = getId(conversation, ['conversationId'])
    if (!id) {
      setNotice({ type: 'error', text: 'The conversation response did not include an ID.' })
      return
    }
    setBusy(true)
    setNotice(null)
    try {
      await loadConversationDetails(id)
      setSection('chat')
      setIsMobileSidebarOpen(false)
      const path = `/chat/${encodeURIComponent(id)}`
      if (window.location.pathname !== path) window.history.pushState({}, '', path)
    } catch (error) {
      setNotice({ type: 'error', text: getApiError(error) })
    } finally {
      setBusy(false)
    }
  }

  async function startConversation(event) {
    event.preventDefault()
    if (!modelId || (!configId && !selectedModelIsOffline)) {
      setNotice({ type: 'error', text: 'Choose a model and a provider configuration unless the model is offline.' })
      return
    }
    setBusy(true)
    setNotice(null)
    try {
      const body = await apiPost('conversations', {
        modelId,
        ...(configId ? { providerConfigId: configId } : {}),
        ...(conversationTitle.trim() ? { title: conversationTitle.trim() } : {}),
      })
      const entity = getEntity(body, ['conversation'])
      const id = getId(entity, ['conversationId'])
      if (!id) throw new Error('Conversation creation succeeded but the response did not include an ID.')
      setActiveConversation(entity)
      setMessages([])
      setMessagePage(0)
      setConversationTitle('')
      setNotice({ type: 'success', text: 'New conversation created.' })
      await loadConversations(0)
      setSection('chat')
      setIsMobileSidebarOpen(false)
      window.history.pushState({}, '', `/chat/${encodeURIComponent(id)}`)
    } catch (error) {
      setNotice({ type: 'error', text: getApiError(error) })
    } finally {
      setBusy(false)
    }
  }

  async function streamMessage(content, isRetry = false) {
    const conversationId = getId(activeConversation, ['conversationId'])
    if (!content || !conversationId || pending || streamControllerRef.current) return

    const assistantId = isRetry && streamingAssistantId
      ? streamingAssistantId
      : `stream-assistant-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const controller = new AbortController()
    streamControllerRef.current = controller
    setStreamingAssistantId(assistantId)
    userCancelledStreamRef.current = false
    shouldStickToBottomRef.current = true
    setPending(true)
    setNotice(null)
    setRetryRequest(null)
    setResourceError('messages', null)

    if (isRetry) {
      setMessages((current) => {
        let found = false
        const updated = current.map((message) => {
          if (message.id !== assistantId) return message
          found = true
          return {
            ...message,
            content: '',
            thinkingContent: '',
            usage: null,
            isThinking: false,
            streamPrefix: '',
            streamPrefixHandled: false,
          }
        })
        return found
          ? updated
          : [...updated, { id: assistantId, role: 'assistant', content: '', thinkingContent: '', usage: null, streamPrefix: '', streamPrefixHandled: false }]
      })
    } else {
      setDraft('')
      const localId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      setMessages((current) => [
        ...current,
        { id: `stream-user-${localId}`, role: 'user', content },
        { id: assistantId, role: 'assistant', content: '', thinkingContent: '', usage: null, streamPrefix: '', streamPrefixHandled: false },
      ])
    }

    try {
      await apiStream(`conversations/${encodeURIComponent(conversationId)}/messages/stream`, {
        content,
        thinking: thinkingEnabled,
        internet: internetEnabled,
      }, {
        signal: controller.signal,
        onEvent: (type, data) => {
          if (activeConversationIdRef.current !== conversationId) return
          if (type === 'token') {
            if (typeof data?.content !== 'string') {
              throw new Error('The server sent a token event without text content.')
            }
            if (!data.content) return
            setMessages((current) => current.map((message) => (
              message.id === assistantId
                ? appendStreamToken(message, data.content, data.isThinking === true)
                : message
            )))
          } else if (type === 'done') {
            setMessages((current) => current.map((message) => (
              message.id === assistantId
                ? {
                    ...message,
                    usage: {
                      inputTokens: Number.isFinite(data?.inputTokens) ? data.inputTokens : null,
                      outputTokens: Number.isFinite(data?.outputTokens) ? data.outputTokens : null,
                    },
                    isThinking: false,
                  }
                : message
            )))
          } else if (type === 'error') {
            throw new ApiError(data?.message || 'The server could not complete the response.', null, data)
          }
        },
      })

      if (activeConversationIdRef.current === conversationId) {
        setConversations((current) => {
          const existing = current.find((conversation) => getId(conversation, ['conversationId']) === conversationId)
          const updated = existing || activeConversation
          return updated
            ? [updated, ...current.filter((conversation) => getId(conversation, ['conversationId']) !== conversationId)]
            : current
        })
        setRetryRequest(null)
      }
    } catch (error) {
      const stillInConversation = activeConversationIdRef.current === conversationId
      if (stillInConversation) {
        setMessages((current) => current.filter((message) => (
          message.id !== assistantId || message.content || message.thinkingContent
        )))
      }
      if (controller.signal.aborted) {
        if (userCancelledStreamRef.current && stillInConversation) {
          setRetryRequest({ content, conversationId })
          setNotice({ type: 'error', text: 'Response stopped. You can retry the request.' })
        }
      } else if (stillInConversation) {
        setRetryRequest({ content, conversationId })
        setNotice({ type: 'error', text: getApiError(error) })
      }
    } finally {
      if (streamControllerRef.current === controller) {
        streamControllerRef.current = null
        userCancelledStreamRef.current = false
        setPending(false)
      }
    }
  }

  function sendMessage(event) {
    event.preventDefault()
    streamMessage(draft.trim())
  }

  function cancelStream() {
    if (!streamControllerRef.current) return
    userCancelledStreamRef.current = true
    streamControllerRef.current.abort()
  }

  function updateThinkingPreference(enabled) {
    setThinkingEnabled(enabled)
    try {
      window.localStorage.setItem(THINKING_PREFERENCE_KEY, String(enabled))
    } catch {
      setNotice({ type: 'error', text: 'Thinking preference changed for this session, but could not be saved on this device.' })
    }
  }

  function updateInternetPreference(enabled) {
    setInternetEnabled(enabled)
    try {
      window.localStorage.setItem(INTERNET_PREFERENCE_KEY, String(enabled))
    } catch {
      setNotice({ type: 'error', text: 'Internet preference changed for this session, but could not be saved on this device.' })
    }
  }

  async function createProvider(event) {
    event.preventDefault()
    setBusy(true)
    setNotice(null)
    try {
      const body = await apiPost('providers', {
        code: providerForm.code.trim(),
        displayName: providerForm.displayName.trim(),
        providerType: providerForm.providerType,
        ...(providerForm.baseUrl.trim() ? { baseUrl: providerForm.baseUrl.trim() } : {}),
      })
      const provider = getEntity(body, ['provider'])
      if (!getId(provider, ['providerId'])) {
        throw new Error('Provider creation succeeded but the response did not include an ID.')
      }
      setProviders((current) => [...current, provider])
      setProviderForm({ code: '', displayName: '', providerType: 'CLOUD', baseUrl: '' })
      setNotice({ type: 'success', text: 'Provider created.' })
      setResourceError('providers', null)
    } catch (error) {
      setNotice({ type: 'error', text: getApiError(error) })
    } finally {
      setBusy(false)
    }
  }

  async function deleteProvider(provider) {
    const id = getId(provider, ['providerId'])
    if (!id || !window.confirm(`Delete provider "${getEntityName(provider, 'this provider')}"?`)) return
    const modelIds = new Set((provider.models || []).map((model) => getId(model, ['modelId'])))
    const providerConfigIds = new Set(configs
      .filter((config) => String(config.providerId || config.provider?.id) === id)
      .map((config) => getId(config, ['configId', 'providerConfigId'])))
    setBusy(true)
    try {
      await apiDelete(`providers/${encodeURIComponent(id)}`)
      setProviders((current) => current.filter((item) => getId(item, ['providerId']) !== id))
      setModels((current) => current.filter((model) => {
        const modelId = getId(model, ['modelId'])
        return String(model.providerId || model.provider?.id || '') !== id
          && (!modelId || !modelIds.has(modelId))
      }))
      setConfigs((current) => current.filter((config) => String(config.providerId || config.provider?.id) !== id))
      if (providerConfigIds.has(configId)) setConfigId('')
      if (configForm.providerId === id) {
        setConfigForm((current) => ({ ...current, providerId: '' }))
        configProviderModelsRequestRef.current += 1
        setConfigProviderModels([])
        setConfigProviderModelsLoading(false)
      }
      if (modelForm.providerId === id) setModelForm((current) => ({ ...current, providerId: '' }))
      if (modelIds.has(modelId)) {
        setModelId('')
        setSelectedModel(null)
      }
      if (getId(selectedProvider, ['providerId']) === id) setSelectedProvider(null)
      setNotice({ type: 'success', text: 'Provider deleted.' })
    } catch (error) {
      setNotice({ type: 'error', text: getApiError(error) })
    } finally {
      setBusy(false)
    }
  }

  async function createModel(event) {
    event.preventDefault()
    const contextWindow = Number(modelForm.contextWindow)
    if (!Number.isInteger(contextWindow) || contextWindow < 1) {
      setNotice({ type: 'error', text: 'Enter a valid context window greater than zero.' })
      return
    }
    setBusy(true)
    setNotice(null)
    try {
      const body = await apiPost('models', {
        providerId: modelForm.providerId,
        modelName: modelForm.modelName.trim(),
        displayName: modelForm.displayName.trim(),
        contextWindow,
      })
      const model = getEntity(body, ['model'])
      if (!getId(model, ['modelId'])) {
        throw new Error('Model creation succeeded but the response did not include an ID.')
      }
      const savedModel = { ...model, providerId: model.providerId || modelForm.providerId }
      setModels((current) => [...current, savedModel])
      setSelectedProvider((current) => getId(current, ['providerId']) === modelForm.providerId
        ? { ...current, models: [...(current.models || []), savedModel] }
        : current)
      if (configForm.providerId === modelForm.providerId) {
        setConfigProviderModels((current) => [...current, savedModel])
      }
      setModelForm((current) => ({ ...current, modelName: '', displayName: '' }))
      setNotice({ type: 'success', text: 'Model created.' })
      setResourceError('models', null)
    } catch (error) {
      setNotice({ type: 'error', text: getApiError(error) })
    } finally {
      setBusy(false)
    }
  }

  async function deleteModel(model) {
    const id = getId(model, ['modelId'])
    if (!id || !window.confirm(`Delete model "${getEntityName(model, 'this model')}"?`)) return
    setBusy(true)
    try {
      await apiDelete(`models/${encodeURIComponent(id)}`)
      setModels((current) => current.filter((item) => getId(item, ['modelId']) !== id))
      setSelectedProvider((current) => current
        ? { ...current, models: (current.models || []).filter((item) => getId(item, ['modelId']) !== id) }
        : current)
      const modelProviderId = String(model.providerId || model.provider?.id || getId(selectedProvider, ['providerId']))
      if (modelProviderId === configForm.providerId) {
        setConfigProviderModels((current) => current.filter((item) => getId(item, ['modelId']) !== id))
      }
      if (modelId === id) setModelId('')
      if (getId(selectedModel, ['modelId']) === id) setSelectedModel(null)
      setNotice({ type: 'success', text: 'Model deleted.' })
    } catch (error) {
      setNotice({ type: 'error', text: getApiError(error) })
    } finally {
      setBusy(false)
    }
  }

  async function deleteAllModels() {
    if (!models.length || !window.confirm(`Delete all ${models.length} models? This cannot be undone.`)) return
    setBusy(true)
    try {
      await apiDelete('models')
      setModels([])
      setSelectedProvider((current) => current ? { ...current, models: [] } : current)
      setModelId('')
      setSelectedModel(null)
      configProviderModelsRequestRef.current += 1
      setConfigProviderModels([])
      setConfigProviderModelsLoading(false)
      setNotice({ type: 'success', text: 'All models deleted.' })
    } catch (error) {
      setNotice({ type: 'error', text: getApiError(error) })
    } finally {
      setBusy(false)
    }
  }

  async function selectConfigProvider(providerId) {
    setConfigForm((current) => ({ ...current, providerId, apiKey: '' }))
    setConfigProviderModels([])
    setResourceError('configProviderModels', null)
    const requestId = ++configProviderModelsRequestRef.current
    setConfigProviderModelsLoading(Boolean(providerId))
    if (!providerId) return
    try {
      const body = await apiGet(`providers/${encodeURIComponent(providerId)}/models`)
      if (requestId === configProviderModelsRequestRef.current) {
        setConfigProviderModels(getItems(body, ['models']))
        setConfigProviderModelsLoading(false)
      }
    } catch (error) {
      if (requestId === configProviderModelsRequestRef.current) {
        setResourceError('configProviderModels', error)
        setConfigProviderModelsLoading(false)
      }
    }
  }

  async function openProvider(provider) {
    const id = getId(provider, ['providerId'])
    if (!id) return
    try {
      const [providerBody, modelsBody] = await Promise.all([
        apiGet(`providers/${encodeURIComponent(id)}`),
        apiGet(`providers/${encodeURIComponent(id)}/models`),
      ])
      setSelectedProvider(getEntity(providerBody, ['provider']))
      setSelectedProvider((current) => ({ ...current, models: getItems(modelsBody, ['models']) }))
      setResourceError('providerDetail', null)
    } catch (error) {
      setResourceError('providerDetail', error)
    }
  }

  async function openConfig(config) {
    const id = getId(config, ['configId', 'providerConfigId'])
    if (!id) return
    try {
      const body = await apiGet(`provider-configs/${encodeURIComponent(id)}`)
      const entity = getEntity(body, ['providerConfig', 'config'])
      setSelectedConfig(entity)
      setResourceError('configDetail', null)
    } catch (error) {
      setResourceError('configDetail', error)
    }
  }

  async function submitConfig(event) {
    event.preventDefault()
    const editing = Boolean(editingConfigId)
    const endpoint = configForm.endpoint.trim()
    const payload = {
      ...(editing ? {} : { providerId: configForm.providerId }),
      ...(editing
        ? { name: configForm.name.trim(), ...(endpoint ? { endpoint } : {}) }
        : {
            configName: configForm.name.trim(),
            ...(endpoint ? { endpointUrl: endpoint } : {}),
          }),
      ...(configForm.apiKey ? { apiKey: configForm.apiKey } : {}),
      ...(editing ? { active: configForm.active } : {}),
    }
    if (!editing && !configProviderIsOffline && !payload.apiKey) {
      setNotice({ type: 'error', text: 'Enter the provider API key to create a configuration.' })
      return
    }
    setBusy(true)
    try {
      const path = editingConfigId
        ? `provider-configs/${encodeURIComponent(editingConfigId)}`
        : 'provider-configs'
      const body = editingConfigId ? await apiPatch(path, payload) : await apiPost(path, payload)
      const saved = getEntity(body, ['providerConfig', 'config'])
      setSelectedConfig(saved)
      setEditingConfigId('')
      setConfigForm({ providerId: '', name: '', endpoint: '', apiKey: '', active: true })
      configProviderModelsRequestRef.current += 1
      setConfigProviderModels([])
      setConfigProviderModelsLoading(false)
      setNotice({ type: 'success', text: editing ? 'Provider configuration updated.' : 'Provider configuration added.' })
      await loadConfigs()
    } catch (error) {
      setNotice({ type: 'error', text: getApiError(error) })
    } finally {
      setBusy(false)
    }
  }

  async function editConfig(config) {
    configProviderModelsRequestRef.current += 1
    setConfigProviderModels([])
    setConfigProviderModelsLoading(false)
    await openConfig(config)
    const id = getId(config, ['configId', 'providerConfigId'])
    setEditingConfigId(id)
    setConfigForm({
      providerId: String(config.providerId || config.provider?.id || ''),
      name: config.config_name || config.configName || config.name || config.displayName || '',
      endpoint: config.endpoint || config.endpointUrl || config.endpoint_url || config.baseUrl || '',
      apiKey: '',
      active: config.active !== false,
    })
  }

  async function testConfig(config) {
    const id = getId(config, ['configId', 'providerConfigId'])
    setBusy(true)
    try {
      const body = await apiPost(`provider-configs/${encodeURIComponent(id)}/test`)
      const result = getEntity(body, ['result'])
      setNotice({
        type: result.success === false || result.reachable === false ? 'error' : 'success',
        text: result.message || (result.success === false ? 'Provider test failed.' : 'Provider connection test completed.'),
      })
    } catch (error) {
      setNotice({ type: 'error', text: getApiError(error) })
    } finally {
      setBusy(false)
    }
  }

  async function deleteConfig(config) {
    const id = getId(config, ['configId', 'providerConfigId'])
    if (!window.confirm(`Delete "${getEntityName(config, 'provider configuration')}"?`)) return
    setBusy(true)
    try {
      await apiDelete(`provider-configs/${encodeURIComponent(id)}`)
      setConfigs((current) => current.filter((item) => getId(item, ['configId', 'providerConfigId']) !== id))
      if (configId === id) setConfigId('')
      setSelectedConfig(null)
      setNotice({ type: 'success', text: 'Provider configuration deleted.' })
    } catch (error) {
      setNotice({ type: 'error', text: getApiError(error) })
    } finally {
      setBusy(false)
    }
  }

  async function renameConversation(event) {
    event.preventDefault()
    const id = editingConversationId
    if (!id || !editingConversationTitle.trim()) return
    setBusy(true)
    try {
      const body = await apiPatch(`conversations/${encodeURIComponent(id)}`, { title: editingConversationTitle.trim() })
      if (getId(activeConversation, ['conversationId']) === id) {
        setActiveConversation(getEntity(body, ['conversation']))
      }
      setEditingConversationId('')
      await loadConversations(0)
      setNotice({ type: 'success', text: 'Conversation renamed.' })
    } catch (error) {
      setNotice({ type: 'error', text: getApiError(error) })
    } finally {
      setBusy(false)
    }
  }

  async function applyConversationSelection() {
    const id = getId(activeConversation, ['conversationId'])
    if (!id || !modelId || (!configId && !selectedModelIsOffline)) return
    setBusy(true)
    try {
      const body = await apiPatch(`conversations/${encodeURIComponent(id)}`, {
        modelId,
        ...(configId ? { providerConfigId: configId } : {}),
      })
      setActiveConversation(getEntity(body, ['conversation']))
      setNotice({ type: 'success', text: configId ? 'Conversation model and provider updated.' : 'Conversation model updated.' })
    } catch (error) {
      setNotice({ type: 'error', text: getApiError(error) })
    } finally {
      setBusy(false)
    }
  }

  async function deleteConversation(conversation) {
    const id = getId(conversation, ['conversationId'])
    if (!window.confirm(`Delete "${getEntityName(conversation, 'this conversation')}" and its messages?`)) return
    setBusy(true)
    try {
      await apiDelete(`conversations/${encodeURIComponent(id)}`)
      setConversations((current) => current.filter((item) => getId(item, ['conversationId']) !== id))
      if (getId(activeConversation, ['conversationId']) === id) {
        setActiveConversation(null)
        setMessages([])
        window.history.replaceState({}, '', '/chat')
      }
      setNotice({ type: 'success', text: 'Conversation deleted.' })
    } catch (error) {
      setNotice({ type: 'error', text: getApiError(error) })
    } finally {
      setBusy(false)
    }
  }

  async function saveProfile(event) {
    event.preventDefault()
    setBusy(true)
    try {
      const body = await apiPatch('users/me', { displayName: profileName.trim() })
      const updatedUser = getEntity(body, ['user'])
      setUser({
        ...(user || {}),
        ...(updatedUser || {}),
        displayName: updatedUser?.displayName || profileName.trim(),
      })
      setNotice({ type: 'success', text: 'Profile updated.' })
    } catch (error) {
      setNotice({ type: 'error', text: getApiError(error) })
    } finally {
      setBusy(false)
    }
  }

  async function logoutEverywhere() {
    if (!window.confirm('Sign out all active sessions for your account?')) return
    setBusy(true)
    try {
      await apiPost('auth/logout-all', undefined, { credentials: 'include' })
      clearTokens()
      onLogout()
    } catch (error) {
      setNotice({ type: 'error', text: getApiError(error) })
    } finally {
      setBusy(false)
    }
  }

  async function deleteAccount() {
    const confirmation = window.prompt('This permanently deletes your account. Type DELETE to confirm.')
    if (confirmation !== 'DELETE') return
    setBusy(true)
    try {
      await apiDelete('users/me')
      clearTokens()
      onLogout()
    } catch (error) {
      setNotice({ type: 'error', text: getApiError(error) })
    } finally {
      setBusy(false)
    }
  }

  async function signOut() {
    setBusy(true)
    try {
      const refreshToken = readRefreshToken()
      await apiPost('auth/logout', refreshToken ? { refreshToken } : undefined, { credentials: 'include' })
      clearTokens()
      onLogout()
    } catch (error) {
      setNotice({ type: 'error', text: getApiError(error) })
    } finally {
      setBusy(false)
    }
  }

  function showSection(nextSection) {
    setSection(nextSection)
    setNotice(null)
    setIsMobileSidebarOpen(false)
    if (nextSection === 'chat' && !activeConversation) {
      window.history.replaceState({}, '', '/chat')
    }
  }

  function renderError(key) {
    return resourceErrors[key] ? <p className="workspace-error" role="alert">{resourceErrors[key]}</p> : null
  }

  useLayoutEffect(() => {
    activeConversationIdRef.current = activeConversationId
  }, [activeConversationId])

  useEffect(() => {
    return () => {
      userCancelledStreamRef.current = false
      streamControllerRef.current?.abort()
    }
  }, [activeConversationId])

  return (
    <main className="game-app workspace-app">
      {isMobileSidebarOpen && <button className="sidebar-backdrop" type="button" aria-label="Close navigation" onClick={() => setIsMobileSidebarOpen(false)} />}
      <aside className={`game-sidebar ${isMobileSidebarOpen ? 'sidebar-open' : ''}`}>
        <a className="game-brand" href="/chat"><span className="brand-mark">✳</span><span>person<span className="brand-accent">.</span>ai</span><span className="brand-mode">PLAY</span></a>
        <button className="new-chat-button" type="button" onClick={() => {
          setActiveConversation(null)
          setMessages([])
          setMessagePage(0)
          setModelId('')
          setConfigId('')
          window.history.pushState({}, '', '/chat')
          showSection('chat')
        }}><span>＋</span> New conversation</button>
        <div className="workspace-nav" aria-label="Workspace sections">
          <button className={section === 'chat' ? 'active' : ''} type="button" onClick={() => showSection('chat')}><Icon>◌</Icon> Chat</button>
          <button className={section === 'providers' ? 'active' : ''} type="button" onClick={() => showSection('providers')}><Icon>◈</Icon> Providers & models</button>
          <button className={section === 'configs' ? 'active' : ''} type="button" onClick={() => showSection('configs')}><Icon>⚙</Icon> My configurations</button>
          <button className={section === 'account' ? 'active' : ''} type="button" onClick={() => showSection('account')}><Icon>◎</Icon> Account</button>
        </div>
        <div className="sidebar-section-title"><span>YOUR ADVENTURES</span><span>{conversations.length.toString().padStart(2, '0')}</span></div>
        {renderError('conversations')}
        <form className="conversation-search" onSubmit={(event) => {
          event.preventDefault()
          loadConversations(0, query)
        }}>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search conversations" aria-label="Search conversations" />
          <button type="submit" aria-label="Search">⌕</button>
        </form>
        <nav className="chat-list" aria-label="Your conversations">
          {conversations.map((conversation) => {
            const id = getId(conversation, ['conversationId'])
            return (
              <div className={`conversation-nav-item ${id === activeConversationId ? 'selected' : ''}`} key={id}>
                {editingConversationId === id ? (
                  <form onSubmit={renameConversation}>
                    <input aria-label="New conversation title" value={editingConversationTitle} onChange={(event) => setEditingConversationTitle(event.target.value)} />
                    <button type="submit" disabled={busy} aria-label="Save title">✓</button>
                    <button type="button" onClick={() => setEditingConversationId('')} aria-label="Cancel rename">×</button>
                  </form>
                ) : (
                  <>
                    <button className="conversation-open" type="button" onClick={() => openConversation(conversation)}>
                      <span className="chat-list-icon">✳</span><span>{getEntityName(conversation, 'Conversation')}</span>
                    </button>
                    <button className="conversation-more" type="button" aria-label={`Options for ${getEntityName(conversation, 'conversation')}`} onClick={() => {
                      setEditingConversationId(id)
                      setEditingConversationTitle(getEntityName(conversation, ''))
                    }}>···</button>
                    <button className="conversation-delete" type="button" aria-label={`Delete ${getEntityName(conversation, 'conversation')}`} onClick={() => deleteConversation(conversation)}>×</button>
                  </>
                )}
              </div>
            )
          })}
        </nav>
        {hasMoreConversations && <button className="load-more-button" type="button" onClick={() => loadConversations(conversationPage + 1)} disabled={busy}>Load more</button>}
        <div className="sidebar-profile">
          <div className="profile-avatar">{displayName.charAt(0).toUpperCase()}</div>
          <div className="profile-details"><strong>{displayName}</strong><span>LEVEL {level} EXPLORER</span></div>
          <button className="logout-button" type="button" onClick={signOut} aria-label="Sign out" title="Sign out" disabled={busy}>↗</button>
        </div>
      </aside>

      <section className="game-main">
        <header className="game-topbar">
          <button className="mobile-menu-button" type="button" onClick={() => setIsMobileSidebarOpen(true)} aria-label="Open navigation">☰</button>
          <div className="breadcrumb"><span>YOUR SPACE</span><span>/</span><strong>{section === 'chat' ? 'CHAT ARENA' : section === 'providers' ? 'PROVIDER CATALOG' : section === 'configs' ? 'MY CONFIGURATIONS' : 'ACCOUNT'}</strong></div>
          <div className="topbar-status"><span className="status-dot" /> PRIVATE WORKSPACE</div>
        </header>

        {notice && <div className={`workspace-notice ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>
          <span>{notice.text}</span>
          {retryContent && <button className="stream-retry-button" type="button" onClick={() => streamMessage(retryContent, true)} disabled={pending}>Retry</button>}
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss notification">×</button>
        </div>}

        {section === 'chat' && (
          <div className="workspace-content chat-section">
            <section className="selection-bar" aria-label="Conversation model configuration">
              <label>MODEL
                <select value={modelId} onChange={(event) => setModelId(event.target.value)}>
                  <option value="">Choose a model</option>
                  {filteredModels.map((model) => <option value={getId(model, ['modelId'])} key={getId(model, ['modelId'])}>{getEntityName(model, 'Model')}</option>)}
                </select>
              </label>
              <label>PROVIDER CONFIG{selectedModelIsOffline ? ' (OPTIONAL)' : ''}
                <select value={configId} onChange={(event) => {
                  setConfigId(event.target.value)
                  setModelId('')
                  setSelectedModel(null)
                  setSelectedConfig(null)
                }}>
                  <option value="">Choose a configuration</option>
                  {configs.map((config) => <option value={getId(config, ['configId', 'providerConfigId'])} key={getId(config, ['configId', 'providerConfigId'])}>{getEntityName(config, 'Configuration')}</option>)}
                </select>
              </label>
              {activeConversation ? <button className="secondary-button" type="button" onClick={applyConversationSelection} disabled={busy || !modelId || (!configId && !selectedModelIsOffline)}>Apply to conversation</button> : null}
              {selectedModel && getId(selectedModel, ['modelId']) === modelId && <span className="model-context">Context {selectedModel.contextWindow ? Number(selectedModel.contextWindow).toLocaleString() : '—'}</span>}
            </section>
            {renderError('modelsByProvider')}{renderError('modelDetail')}
            {!activeConversation ? (
              <section className="workspace-empty">
                <div className="welcome-emblem"><span>✳</span></div>
                <span className="arena-kicker">YOUR AI. YOUR PROVIDER. YOUR ADVENTURE.</span>
                <h1>What shall we <span>explore?</span></h1>
                <p>Choose the model and provider configuration you want to use, then start a conversation.</p>
                <form className="start-conversation-form" onSubmit={startConversation}>
                  <input value={conversationTitle} onChange={(event) => setConversationTitle(event.target.value)} placeholder="Conversation title (optional)" aria-label="Conversation title" maxLength={120} />
                  <button className="workspace-primary-button" type="submit" disabled={busy || !modelId || (!configId && !selectedModelIsOffline)}>{busy ? 'Starting…' : 'Start conversation'} <span>↗</span></button>
                </form>
                {(!models.length || (!configs.length && !selectedModelIsOffline)) && <p className="setup-hint">Choose an available model and add a provider configuration if required. Offline models do not need one.</p>}
                {renderError('configs')}{renderError('models')}
              </section>
            ) : (
              <>
                <section className="conversation-heading">
                  <div><span className="arena-kicker">ACTIVE CONVERSATION</span><h1>{getEntityName(activeConversation, 'Conversation')}</h1></div>
                  <button className="secondary-button" type="button" onClick={() => {
                    setActiveConversation(null)
                    setMessages([])
                    setMessagePage(0)
                    window.history.pushState({}, '', '/chat')
                  }}>New conversation</button>
                </section>
                <section
                  ref={messageThreadRef}
                  className="message-thread api-message-thread"
                  aria-live="polite"
                  onScroll={(event) => {
                    const thread = event.currentTarget
                    shouldStickToBottomRef.current = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80
                  }}
                >
                  {hasMoreMessages && <button className="load-more-button" type="button" onClick={() => loadMessages(activeConversationId, messagePage + 1, true)} disabled={busy}>Load more messages</button>}
                  {renderError('messages')}
                  {messages.map((message, index) => (
                    <article className={`message-row ${message.role}`} key={message.id || index}>
                      <div className={`message-avatar ${message.role}`}>{message.role === 'assistant' ? '✳' : displayName.charAt(0).toUpperCase()}</div>
                      <div className="message-body">
                        <div className="message-author">{message.role === 'assistant' ? 'PERSON AI' : displayName.toUpperCase()}<span>{message.role === 'assistant' ? 'QUEST GUIDE' : 'YOU'}</span></div>
                        <div className="message-markdown">
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={{
                              pre: CodeBlock,
                              table: ({ children }) => <div className="markdown-table-wrap"><table>{children}</table></div>,
                            }}
                          >
                            {String(message.content ?? '')}
                          </ReactMarkdown>
                        </div>
                        {message.thinkingContent && (
                          <details className="message-thinking">
                            <summary>Reasoning</summary>
                            <div className="thinking-content">
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.thinkingContent}</ReactMarkdown>
                            </div>
                          </details>
                        )}
                        {message.usage && (message.usage.inputTokens !== null || message.usage.outputTokens !== null) && (
                          <div className="message-usage">
                            {message.usage.inputTokens !== null ? `${message.usage.inputTokens} input` : ''}
                            {message.usage.inputTokens !== null && message.usage.outputTokens !== null ? ' · ' : ''}
                            {message.usage.outputTokens !== null ? `${message.usage.outputTokens} output` : ''}
                            {' tokens'}
                          </div>
                        )}
                      </div>
                    </article>
                  ))}
                  {pending && <div className="message-row assistant"><div className="message-avatar assistant">✳</div><div className="typing-indicator" aria-label="AI response in progress"><i /><i /><i /></div><span className="streaming-label">{messages.find((message) => message.id === streamingAssistantId)?.isThinking ? 'Thinking' : 'Generating response'}</span></div>}
                  {!messages.length && !resourceErrors.messages && <p className="setup-hint">This conversation is ready. Send the first message.</p>}
                </section>
                <form className="chat-composer" onSubmit={sendMessage}>
                  <textarea ref={composerRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      event.currentTarget.form.requestSubmit()
                    }
                  }} placeholder="Message your AI..." aria-label="Message your AI" rows={1} maxLength={2000} />
                  <div className="composer-tools">
                    <span><kbd>↵</kbd> send <span className="composer-divider">·</span><kbd>⇧ ↵</kbd> new line</span>
                    <label className="thinking-toggle" title="Enable or disable model reasoning for this conversation">
                      <input type="checkbox" checked={thinkingEnabled} onChange={(event) => updateThinkingPreference(event.target.checked)} />
                      <span>💡 Thinking</span>
                    </label>
                    <label className="thinking-toggle" title="Enable or disable internet and tool access for this conversation">
                      <input type="checkbox" checked={internetEnabled} onChange={(event) => updateInternetPreference(event.target.checked)} />
                      <span>🌐 Internet</span>
                    </label>
                    <span className="composer-count">{draft.length}/2000</span>
                  </div>
                  {pending
                    ? <button type="button" className="send-button stop-button" onClick={cancelStream} aria-label="Stop response">■</button>
                    : <button type="submit" className="send-button" disabled={!draft.trim() || busy} aria-label="Send message">↑</button>}
                </form>
                <p className="demo-note"><span>✦</span> POWERED BY YOUR SELECTED MODEL <span>✦</span></p>
              </>
            )}
          </div>
        )}

        {section === 'providers' && (
          <div className="workspace-content">
            <div className="section-title"><span className="arena-kicker">SHARED CATALOG</span><h1>Providers & models</h1><p>Browse available AI providers and their active models.</p></div>
            {renderError('providers')}{renderError('providerDetail')}
            <div className="catalog-management-grid">
              <form className="management-form" onSubmit={createProvider}>
                <span className="arena-kicker">PROVIDER MANAGEMENT</span>
                <h2>Create a provider</h2>
                <label>Provider code<input value={providerForm.code} onChange={(event) => setProviderForm((current) => ({ ...current, code: event.target.value }))} placeholder="openai" maxLength={60} required /></label>
                <label>Display name<input value={providerForm.displayName} onChange={(event) => setProviderForm((current) => ({ ...current, displayName: event.target.value }))} placeholder="OpenAI" maxLength={100} required /></label>
                <label>Provider type<select value={providerForm.providerType} onChange={(event) => setProviderForm((current) => ({ ...current, providerType: event.target.value }))}><option value="CLOUD">Cloud</option><option value="LOCAL">Local</option><option value="SELF_HOSTED">Self-hosted</option></select></label>
                <label>Base URL <span className="optional-label">optional</span><input type="url" value={providerForm.baseUrl} onChange={(event) => setProviderForm((current) => ({ ...current, baseUrl: event.target.value }))} placeholder="https://api.openai.com/v1" /></label>
                <button className="workspace-primary-button" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Create provider'}</button>
              </form>
              <form className="management-form" onSubmit={createModel}>
                <span className="arena-kicker">MODEL MANAGEMENT</span>
                <h2>Create a model</h2>
                <label>Provider<select value={modelForm.providerId} onChange={(event) => setModelForm((current) => ({ ...current, providerId: event.target.value }))} required><option value="">Choose provider</option>{providers.map((provider) => <option key={getId(provider, ['providerId'])} value={getId(provider, ['providerId'])}>{getEntityName(provider, 'Provider')}</option>)}</select></label>
                <label>Model identifier<input value={modelForm.modelName} onChange={(event) => setModelForm((current) => ({ ...current, modelName: event.target.value }))} placeholder="gpt-4" maxLength={160} required /></label>
                <label>Display name<input value={modelForm.displayName} onChange={(event) => setModelForm((current) => ({ ...current, displayName: event.target.value }))} placeholder="GPT-4" maxLength={100} required /></label>
                <label>Context window<input type="number" min="1" step="1" value={modelForm.contextWindow} onChange={(event) => setModelForm((current) => ({ ...current, contextWindow: event.target.value }))} required /></label>
                <div className="form-actions"><button className="workspace-primary-button" type="submit" disabled={busy || !providers.length}>{busy ? 'Saving…' : 'Create model'}</button><button className="danger-button" type="button" onClick={deleteAllModels} disabled={busy || !models.length}>Delete all models</button></div>
              </form>
            </div>
            <div className="catalog-grid">{providers.map((provider) => {
              const id = getId(provider, ['providerId'])
              return <button className={`catalog-card ${getId(selectedProvider, ['providerId']) === id ? 'chosen' : ''}`} key={id} type="button" onClick={() => openProvider(provider)}>
                <span className="catalog-card-symbol">◈</span><strong>{getEntityName(provider, 'Provider')}</strong><small>{provider.description || provider.status || 'Available provider'}</small><span className="catalog-open">View details ↗</span>
              </button>
            })}</div>
            {selectedProvider && <section className="detail-panel"><div className="panel-title"><div><span className="arena-kicker">PROVIDER DETAILS</span><h2>{getEntityName(selectedProvider, 'Provider')}</h2></div><div className="form-actions"><button className="danger-button" type="button" onClick={() => deleteProvider(selectedProvider)} disabled={busy}>Delete provider</button><button className="secondary-button" type="button" onClick={() => setSelectedProvider(null)}>Close</button></div></div>
              <dl className="detail-grid">{Object.entries(selectedProvider).filter(([key, value]) => !['models', 'id', 'providerId'].includes(key) && ['string', 'number', 'boolean'].includes(typeof value)).slice(0, 8).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl>
              <h3>Active models</h3><div className="model-chip-list">{(selectedProvider.models || []).map((model) => {
                const modelKey = getId(model, ['modelId'])
                return <div className="model-chip" key={modelKey}>
                  <button type="button" onClick={() => setModelId(modelKey)}>{getEntityName(model, 'Model')} {model.contextWindow ? `· ${Number(model.contextWindow).toLocaleString()} context` : ''}{model.isOffline === true ? ' · OFFLINE' : ''}</button>
                  <button className="model-chip-delete" type="button" onClick={() => deleteModel(model)} disabled={busy} aria-label={`Delete ${getEntityName(model, 'model')}`}>×</button>
                </div>
              })}</div>
            </section>}
            {!providers.length && !resourceErrors.providers && <p className="setup-hint">No active providers were returned by the backend.</p>}
          </div>
        )}

        {section === 'configs' && (
          <div className="workspace-content">
            <div className="section-title"><span className="arena-kicker">PRIVATE TO YOUR ACCOUNT</span><h1>My configurations</h1><p>Manage your provider connections. Secret credentials are only sent when creating or replacing them.</p></div>
            {renderError('configs')}{renderError('configDetail')}
            <div className="config-layout">
              <form className="management-form" onSubmit={submitConfig}>
                <span className="arena-kicker">{editingConfigId ? 'EDIT CONFIGURATION' : 'ADD A PROVIDER'}</span>
                <h2>{editingConfigId ? 'Update connection' : 'New connection'}</h2>
                {!editingConfigId && <label>Provider<select required value={configForm.providerId} onChange={(event) => selectConfigProvider(event.target.value)}><option value="">Choose provider</option>{providers.map((provider) => <option key={getId(provider, ['providerId'])} value={getId(provider, ['providerId'])}>{getEntityName(provider, 'Provider')}</option>)}</select></label>}
                <label>Configuration name<input required value={configForm.name} onChange={(event) => setConfigForm((current) => ({ ...current, name: event.target.value }))} placeholder="My personal connection" maxLength={100} /></label>
                <label>Provider endpoint <span className="optional-label">optional</span><input type="url" value={configForm.endpoint} onChange={(event) => setConfigForm((current) => ({ ...current, endpoint: event.target.value }))} placeholder="http://localhost:8081" /></label>
                {(!editingConfigId && configProviderIsOffline)
                  ? <p className="setup-hint">API key is not required for this offline provider.</p>
                  : <label>{editingConfigId ? 'Replace API key' : 'Provider API key'} <span className="optional-label">{editingConfigId ? 'leave blank to keep current' : 'required'}</span><input type="password" autoComplete="new-password" value={configForm.apiKey} onChange={(event) => setConfigForm((current) => ({ ...current, apiKey: event.target.value }))} required={!editingConfigId && !configProviderIsOffline} /></label>}
                {configProviderModelsLoading && <p className="setup-hint">Checking provider models…</p>}
                {renderError('configProviderModels')}
                {editingConfigId && <label className="inline-checkbox"><input type="checkbox" checked={configForm.active} onChange={(event) => setConfigForm((current) => ({ ...current, active: event.target.checked }))} /> Configuration active</label>}
                <div className="form-actions"><button className="workspace-primary-button" type="submit" disabled={busy || configProviderModelsLoading}>{busy ? 'Saving…' : editingConfigId ? 'Save changes' : 'Add configuration'}</button>{editingConfigId && <button className="secondary-button" type="button" onClick={() => { setEditingConfigId(''); setConfigForm({ providerId: '', name: '', endpoint: '', apiKey: '', active: true }) }}>Cancel</button>}</div>
              </form>
              <section className="config-list"><div className="config-list-toolbar"><span className="arena-kicker">SAVED CONNECTIONS</span><select aria-label="Filter configurations by provider" value={configProviderFilter} onChange={(event) => {
                const providerId = event.target.value
                setConfigProviderFilter(providerId)
                loadConfigs(providerId)
              }}><option value="">All providers</option>{providers.map((provider) => <option key={getId(provider, ['providerId'])} value={getId(provider, ['providerId'])}>{getEntityName(provider, 'Provider')}</option>)}</select></div>{configs.length ? configs.map((config) => {
                const id = getId(config, ['configId', 'providerConfigId'])
                const provider = providers.find((item) => getId(item, ['providerId']) === String(config.providerId || config.provider?.id))
                return <article className="config-card" key={id}><div className="config-card-head"><span className="catalog-card-symbol">◈</span><div><strong>{getEntityName(config, 'Configuration')}</strong><small>{getEntityName(provider, config.providerName || 'Provider')}</small></div><span className={`active-pill ${config.active === false ? 'inactive' : ''}`}>{config.active === false ? 'INACTIVE' : 'ACTIVE'}</span></div><p>Credential {config.credentialConfigured ? 'configured' : 'not configured'}{config.credentialMasked ? ` · ${config.credentialMasked}` : ''}</p><div className="config-actions"><button type="button" onClick={() => openConfig(config)}>Details</button><button type="button" onClick={() => editConfig(config)}>Edit</button><button type="button" onClick={() => testConfig(config)} disabled={busy}>Test</button><button type="button" className="danger-text" onClick={() => deleteConfig(config)} disabled={busy}>Delete</button></div></article>
              }) : <p className="setup-hint">No provider configurations yet. Add one to start a conversation.</p>}
              {selectedConfig && <div className="detail-panel compact-detail"><span className="arena-kicker">CONFIG DETAILS</span><h3>{getEntityName(selectedConfig, 'Configuration')}</h3><dl className="detail-grid">{Object.entries(selectedConfig).filter(([key, value]) => !/key|secret|credential|cipher/i.test(key) && ['string', 'number', 'boolean'].includes(typeof value)).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl></div>}
              </section>
            </div>
          </div>
        )}

        {section === 'account' && (
          <div className="workspace-content account-content">
            <div className="section-title"><span className="arena-kicker">PLAYER PROFILE</span><h1>Account settings</h1><p>Manage your profile and account sessions.</p></div>
            {renderError('account')}
            <form className="management-form profile-form" onSubmit={saveProfile}>
              <span className="arena-kicker">YOUR PROFILE</span><h2>Player details</h2>
              <label>Email address<input value={profileEmail} readOnly /></label>
              <label>Display name<input value={profileName} onChange={(event) => setProfileName(event.target.value)} minLength={2} maxLength={100} required /></label>
              <button className="workspace-primary-button" type="submit" disabled={busy}>Save profile</button>
            </form>
            <section className="danger-zone"><span className="arena-kicker">SESSION & ACCOUNT</span><h2>Account actions</h2><p>Sign out on this device, revoke every active session, or permanently delete your account.</p><div className="account-actions"><button className="secondary-button" type="button" onClick={signOut} disabled={busy}>Sign out</button><button className="secondary-button" type="button" onClick={logoutEverywhere} disabled={busy}>Sign out all sessions</button><button className="danger-button" type="button" onClick={() => setConfirmingDelete(true)} disabled={busy}>Delete account</button></div></section>
            {confirmingDelete && <div className="delete-confirmation" role="alertdialog" aria-modal="true" aria-labelledby="delete-title"><div><span className="arena-kicker">THIS CANNOT BE UNDONE</span><h2 id="delete-title">Delete your account?</h2><p>This permanently removes your account. Confirm by typing DELETE in the next prompt.</p><button className="danger-button" type="button" onClick={deleteAccount}>Continue to confirmation</button><button className="secondary-button" type="button" onClick={() => setConfirmingDelete(false)}>Cancel</button></div></div>}
          </div>
        )}
      </section>
    </main>
  )
}
