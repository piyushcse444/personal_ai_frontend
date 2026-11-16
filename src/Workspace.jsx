import { Children, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  ApiError,
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  apiRequest,
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

function isChatModel(model) {
  return !model?.modelType || String(model.modelType).toUpperCase() === 'CHAT'
}

function getTranscriptionError(error) {
  if (error instanceof ApiError) {
    if (error.status === 429) return 'Another transcription is in progress. Please try again later.'
    if (error.status === 503) return 'Audio service temporarily unavailable.'
    if (error.status === 507) return 'Not enough GPU memory for audio transcription.'
    if (error.status === 400) return 'Please select a valid speech-to-text model and try again.'
    if (error.status >= 500) return 'Failed to transcribe audio, please try again.'
  }
  return getApiError(error)
}

function getId(item, keys = []) {
  return getEntityId(item, keys)
}

function getMessageRole(message) {
  const role = String(message?.role || message?.type || message?.sender || '').toLowerCase()
  return role.includes('assistant') || role.includes('ai') ? 'assistant' : 'user'
}

function normalizeMessage(message, index = 0) {
  const imageBase64 = message?.imageBase64 || message?.image_base64 || ''
  const imageMimeType = message?.imageMimeType || message?.image_mime_type || ''
  const imageUrl = message?.imageUrl || message?.image_url || ''
  return {
    ...message,
    id: getId(message, ['messageId']) || `message-${index}`,
    role: getMessageRole(message),
    content: getMessageContent(message),
    imageSrc: imageUrl || (imageBase64 && imageMimeType
      ? `data:${imageMimeType};base64,${imageBase64}`
      : ''),
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== 'string' || !reader.result.includes(',')) {
        reject(new Error('The selected image could not be read.'))
        return
      }
      resolve(reader.result.slice(reader.result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error || new Error('The selected image could not be read.'))
    reader.readAsDataURL(file)
  })
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

function groupConversationsByModel(conversations) {
  const groups = new Map()

  conversations.forEach((conversation) => {
    const model = conversation?.model || {}
    const modelName = model.modelName || ''
    const key = modelName || model.id || conversation.modelId || 'unknown-model'
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        displayName: model.displayName || modelName || 'Unknown model',
        supportsVision: Boolean(model.supportsVision),
        conversations: [],
      })
    }
    groups.get(key).conversations.push(conversation)
  })

  return Array.from(groups.values(), (group) => ({
    ...group,
    conversations: group.conversations.sort((first, second) => {
      const firstUpdatedAt = Date.parse(first.updatedAt || '')
      const secondUpdatedAt = Date.parse(second.updatedAt || '')
      if (!Number.isFinite(firstUpdatedAt)) return Number.isFinite(secondUpdatedAt) ? 1 : 0
      if (!Number.isFinite(secondUpdatedAt)) return -1
      return secondUpdatedAt - firstUpdatedAt
    }),
  }))
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
  const [asrModels, setAsrModels] = useState([])
  const [asrModelsLoading, setAsrModelsLoading] = useState(false)
  const [isAsrModelDialogOpen, setIsAsrModelDialogOpen] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [isStartingRecording, setIsStartingRecording] = useState(false)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [recordingSeconds, setRecordingSeconds] = useState(0)
  const [transcriptionError, setTranscriptionError] = useState('')
  const [configs, setConfigs] = useState([])
  const [conversations, setConversations] = useState([])
  const [expandedModelGroups, setExpandedModelGroups] = useState({})
  const [resourceErrors, setResourceErrors] = useState({})
  const [notice, setNotice] = useState(null)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [configProviderFilter, setConfigProviderFilter] = useState('')
  const [conversationPage, setConversationPage] = useState(0)
  const [hasMoreConversations, setHasMoreConversations] = useState(false)
  const [activeConversation, setActiveConversation] = useState(null)
  const [messages, setMessages] = useState([])
  const [messageHistoryLoadedFor, setMessageHistoryLoadedFor] = useState('')
  const [messagePage, setMessagePage] = useState(0)
  const [hasMoreMessages, setHasMoreMessages] = useState(false)
  const [draft, setDraft] = useState('')
  const [isComposerExpanded, setIsComposerExpanded] = useState(false)
  const [selectedImage, setSelectedImage] = useState(null)
  const [imageLoading, setImageLoading] = useState(false)
  const [isAttachmentMenuOpen, setIsAttachmentMenuOpen] = useState(false)
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
  const [isOfflineModelModalOpen, setIsOfflineModelModalOpen] = useState(false)
  const [offlineModels, setOfflineModels] = useState([])
  const [offlineModelsLoading, setOfflineModelsLoading] = useState(false)
  const [offlineModelError, setOfflineModelError] = useState('')
  const [offlineModelNotice, setOfflineModelNotice] = useState('')
  const [unloadingModelId, setUnloadingModelId] = useState('')
  const composerRef = useRef(null)
  const attachmentMenuRef = useRef(null)
  const messageThreadRef = useRef(null)
  const shouldStickToBottomRef = useRef(true)
  const streamControllerRef = useRef(null)
  const imageInputRef = useRef(null)
  const mediaRecorderRef = useRef(null)
  const mediaStreamRef = useRef(null)
  const recordedChunksRef = useRef([])
  const recordingFailedRef = useRef(false)
  const audioRecordingRequestRef = useRef(0)
  const configProviderModelsRequestRef = useRef(0)
  const userCancelledStreamRef = useRef(false)
  const activeConversationIdRef = useRef('')
  const activeConversationId = getId(activeConversation, ['conversationId'])
  const retryContent = retryRequest?.conversationId === activeConversationId ? retryRequest.content : ''
  const retryImage = retryRequest?.conversationId === activeConversationId ? retryRequest.image : null
  const canRetry = Boolean(retryContent || retryImage)
  const displayName = user?.displayName || user?.name || user?.email || getDisplayNameFromToken(readAccessToken() || '')
  const level = Math.floor(messages.length / 5) + 1

  useLayoutEffect(() => {
    const thread = messageThreadRef.current
    if (thread && shouldStickToBottomRef.current) {
      thread.scrollTop = thread.scrollHeight
    }
  }, [messages, pending])

  useEffect(() => {
    if (!isRecording) return undefined
    const timer = window.setInterval(() => {
      setRecordingSeconds((seconds) => seconds + 1)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [isRecording])

  useEffect(() => {
    if (!isAttachmentMenuOpen) return undefined

    function handleAttachmentMenuPointerDown(event) {
      if (!attachmentMenuRef.current?.contains(event.target)) setIsAttachmentMenuOpen(false)
    }

    function handleAttachmentMenuKeyDown(event) {
      if (event.key === 'Escape') setIsAttachmentMenuOpen(false)
    }

    document.addEventListener('pointerdown', handleAttachmentMenuPointerDown)
    window.addEventListener('keydown', handleAttachmentMenuKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handleAttachmentMenuPointerDown)
      window.removeEventListener('keydown', handleAttachmentMenuKeyDown)
    }
  }, [isAttachmentMenuOpen])

  useLayoutEffect(() => {
    const composer = composerRef.current
    if (!composer) return

    composer.style.height = 'auto'
    const scrollHeight = composer.scrollHeight
    const maxHeight = Number.parseFloat(window.getComputedStyle(composer).maxHeight)
    const nextHeight = Number.isFinite(maxHeight) ? Math.min(scrollHeight, maxHeight) : scrollHeight
    composer.style.height = `${nextHeight}px`
    composer.style.overflowY = scrollHeight > nextHeight ? 'auto' : 'hidden'
  }, [draft])

  useEffect(() => () => {
    audioRecordingRequestRef.current += 1
    const recorder = mediaRecorderRef.current
    if (recorder) {
      recorder.ondataavailable = null
      recorder.onstop = null
      recorder.onerror = null
    }
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop())
  }, [])

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
      setMessages((current) => append ? [...current, ...normalized] : normalized)
      if (!append) setMessageHistoryLoadedFor(conversationId)
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
    setMessages([])
    setMessageHistoryLoadedFor('')
    setHasMoreMessages(false)
    setMessagePage(0)
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
        setMessageHistoryLoadedFor('')
        setSelectedImage(null)
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
    const chatModels = models.filter(isChatModel)
    return providerId
      ? chatModels.filter((model) => String(model.providerId || model.provider?.id) === String(providerId))
      : chatModels
  }, [configs, configId, models])
  const conversationGroups = useMemo(() => groupConversationsByModel(conversations), [conversations])
  const selectedCatalogModel = models.find((model) => getId(model, ['modelId']) === modelId)
  const selectedDetailModel = getId(selectedModel, ['modelId']) === modelId ? selectedModel : null
  const activeConversationModelId = String(activeConversation?.modelId || activeConversation?.model?.id || '')
  const activeCatalogModel = models.find((model) => getId(model, ['modelId']) === activeConversationModelId)
  const activeDetailModel = getId(selectedModel, ['modelId']) === activeConversationModelId ? selectedModel : null
  const activeConversationModel = [activeConversation?.model, activeCatalogModel, activeDetailModel]
    .find((model) => typeof model?.supportsVision === 'boolean')
  const selectedVisionModel = [selectedCatalogModel, selectedDetailModel]
    .find((model) => typeof model?.supportsVision === 'boolean')
  const visionModel = activeConversation ? activeConversationModel : selectedVisionModel
  const supportsVision = visionModel?.supportsVision === true
  const selectedModelForChat = selectedDetailModel || selectedCatalogModel
  const selectedModelIsChat = isChatModel(selectedModelForChat)
  const conversationHasMessages = messages.length > 0 || hasMoreMessages
  const conversationSelectionLocked = Boolean(activeConversation && (
    conversationHasMessages || messageHistoryLoadedFor !== activeConversationId
  ))
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
    if (!modelId || !selectedModelIsChat) {
      setNotice({ type: 'error', text: 'Choose a chat model to start a conversation.' })
      return
    }
    if (!configId && !selectedModelIsOffline) {
      setNotice({ type: 'error', text: 'Choose a model and a provider configuration unless the model is offline.' })
      return
    }
    setBusy(true)
    setNotice(null)
    try {
      const body = await apiPost('conversations', {
        modelId,
        ...(!selectedModelIsOffline && configId ? { providerConfigId: configId } : {}),
        ...(conversationTitle.trim() ? { title: conversationTitle.trim() } : {}),
      })
      const entity = getEntity(body, ['conversation'])
      const id = getId(entity, ['conversationId'])
      if (!id) throw new Error('Conversation creation succeeded but the response did not include an ID.')
      setActiveConversation(entity)
      setMessages([])
      setMessageHistoryLoadedFor(id)
      setMessagePage(0)
      setHasMoreMessages(false)
      setSelectedImage(null)
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

  async function streamMessage(content, isRetry = false, image = null) {
    const conversationId = getId(activeConversation, ['conversationId'])
    if ((!content && !image) || !conversationId || pending || streamControllerRef.current) return

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
      setIsComposerExpanded(false)
      const localId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      setMessages((current) => [
        ...current,
        {
          id: `stream-user-${localId}`,
          role: 'user',
          content,
          ...(image ? {
            imageBase64: image.base64,
            imageMimeType: image.mimeType,
            imageSrc: image.previewUrl,
          } : {}),
        },
        { id: assistantId, role: 'assistant', content: '', thinkingContent: '', usage: null, streamPrefix: '', streamPrefixHandled: false },
      ])
    }

    try {
      await apiStream(`conversations/${encodeURIComponent(conversationId)}/messages/stream`, {
        content: content || '',
        thinking: thinkingEnabled,
        internet: internetEnabled,
        ...(image ? { imageBase64: image.base64, imageMimeType: image.mimeType } : {}),
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
          setRetryRequest({ content, image, conversationId })
          setNotice({ type: 'error', text: 'Response stopped. You can retry the request.' })
        }
      } else if (stillInConversation) {
        setRetryRequest({ content, image, conversationId })
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
    const content = draft.trim()
    if (!content && !selectedImage) return
    const image = selectedImage
    setSelectedImage(null)
    if (imageInputRef.current) imageInputRef.current.value = ''
    streamMessage(content, false, image)
  }

  function releaseRecordingStream() {
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop())
    mediaStreamRef.current = null
  }

  async function startAudioRecording(asrModelId) {
    if (isStartingRecording || isTranscribing || mediaRecorderRef.current) return
    if (!asrModelId) {
      setTranscriptionError('Select a speech-to-text model before recording.')
      return
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setTranscriptionError('Microphone recording requires a secure connection and a supported browser.')
      return
    }

    setTranscriptionError('')
    setIsStartingRecording(true)
    const requestId = audioRecordingRequestRef.current + 1
    audioRecordingRequestRef.current = requestId
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (audioRecordingRequestRef.current !== requestId) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      mediaStreamRef.current = stream
      const mimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/mp4']
      const mimeType = typeof window.MediaRecorder.isTypeSupported === 'function'
        ? mimeTypes.find((type) => window.MediaRecorder.isTypeSupported(type))
        : ''
      const recorder = new window.MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      const modelIdForRecording = asrModelId
      mediaRecorderRef.current = recorder
      recordedChunksRef.current = []
      recordingFailedRef.current = false
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordedChunksRef.current.push(event.data)
      }
      recorder.onerror = () => {
        recordingFailedRef.current = true
        setIsRecording(false)
        mediaRecorderRef.current = null
        recordedChunksRef.current = []
        setTranscriptionError('Audio recording failed. Please try again.')
        releaseRecordingStream()
      }
      recorder.onstop = async () => {
        setIsRecording(false)
        releaseRecordingStream()
        mediaRecorderRef.current = null
        if (recordingFailedRef.current) return

        const chunks = recordedChunksRef.current
        recordedChunksRef.current = []
        const audioBlob = new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type || 'audio/webm' })
        if (!audioBlob.size) {
          setTranscriptionError('No audio was recorded. Please try again.')
          return
        }

        const extension = audioBlob.type.includes('ogg') ? 'ogg'
          : audioBlob.type.includes('mp4') ? 'm4a'
            : 'webm'
        const formData = new FormData()
        formData.append('audio', audioBlob, `recording.${extension}`)
        formData.append('modelId', modelIdForRecording)
        setIsTranscribing(true)
        setTranscriptionError('')
        try {
          const result = await apiRequest('audio/transcribe', { method: 'POST', body: formData })
          if (result?.success === false) throw new Error(result.message || 'Failed to transcribe audio, please try again.')
          const transcription = typeof result?.transcription === 'string' ? result.transcription.trim() : ''
          if (!transcription) throw new Error('No speech was detected. Try recording again.')
          setDraft((current) => current.trim() ? `${current.trimEnd()}\n${transcription}` : transcription)
          window.requestAnimationFrame(() => {
            const composer = composerRef.current
            if (!composer) return
            if (composer.scrollHeight > 42) setIsComposerExpanded(true)
            composer.focus()
          })
        } catch (error) {
          setTranscriptionError(getTranscriptionError(error))
        } finally {
          setIsTranscribing(false)
        }
      }
      recorder.start()
      setRecordingSeconds(0)
      setIsRecording(true)
      setIsStartingRecording(false)
    } catch (error) {
      if (audioRecordingRequestRef.current !== requestId) return
      releaseRecordingStream()
      mediaRecorderRef.current = null
      setIsStartingRecording(false)
      const permissionError = error?.name === 'NotAllowedError' || error?.name === 'SecurityError'
      const missingMicrophone = error?.name === 'NotFoundError'
      setTranscriptionError(permissionError
        ? 'Microphone access was denied. Allow microphone access in your browser and try again.'
        : missingMicrophone
          ? 'No microphone was found on this device.'
          : getApiError(error))
    }
  }

  function toggleAudioRecording() {
    if (isRecording) {
      const recorder = mediaRecorderRef.current
      if (recorder && recorder.state !== 'inactive') recorder.stop()
      return
    }

    if (isStartingRecording || isTranscribing) return
    setTranscriptionError('')
    setIsStartingRecording(true)
    setAsrModelsLoading(true)
    apiGet('models?type=ASR')
      .then((body) => {
        const availableModels = getItems(body, ['models'])
          .filter((model) => String(model?.modelType || '').toUpperCase() === 'ASR')
          .filter((model) => getId(model, ['modelId']))
        setAsrModels(availableModels)
        setResourceError('asrModels', null)

        if (!availableModels.length) {
          setTranscriptionError('No speech-to-text models are available.')
          return
        }

        if (availableModels.length > 1) {
          setIsAsrModelDialogOpen(true)
          return
        }

        const onlyModelId = getId(availableModels[0], ['modelId'])
        setIsStartingRecording(false)
        startAudioRecording(onlyModelId)
      })
      .catch((error) => {
        setTranscriptionError(getApiError(error))
      })
      .finally(() => {
        setAsrModelsLoading(false)
        setIsStartingRecording(false)
      })
  }

  function chooseAsrModel(model) {
    const asrModelId = getId(model, ['modelId'])
    if (!asrModelId || isStartingRecording) return
    setIsAsrModelDialogOpen(false)
    startAudioRecording(asrModelId)
  }

  async function selectImage(event) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setNotice({ type: 'error', text: 'Choose a PNG, JPEG, or WebP image.' })
      return
    }

    setImageLoading(true)
    setNotice(null)
    try {
      const base64 = await fileToBase64(file)
      setSelectedImage({
        base64,
        mimeType: file.type,
        name: file.name,
        previewUrl: `data:${file.type};base64,${base64}`,
      })
    } catch (error) {
      setNotice({ type: 'error', text: getApiError(error) })
    } finally {
      setImageLoading(false)
    }
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
    if (!id || conversationSelectionLocked || !modelId || !selectedModelIsChat || (!configId && !selectedModelIsOffline)) return
    setBusy(true)
    try {
      const body = await apiPatch(`conversations/${encodeURIComponent(id)}`, {
        modelId,
        providerConfigId: selectedModelIsOffline ? null : configId,
      })
      setActiveConversation(getEntity(body, ['conversation']))
      setNotice({ type: 'success', text: configId && !selectedModelIsOffline ? 'Conversation model and provider updated.' : 'Conversation model updated.' })
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
        setMessageHistoryLoadedFor('')
        setSelectedImage(null)
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

  async function loadOfflineModels() {
    setOfflineModelsLoading(true)
    setOfflineModelError('')
    try {
      const body = await apiGet('unsloth/models')
      setOfflineModels(getItems(body, ['models']))
      return true
    } catch (error) {
      setOfflineModelError(error instanceof ApiError && error.status < 500
        ? getApiError(error)
        : 'Cannot connect to Unsloth service. Please ensure the service is running.')
      return false
    } finally {
      setOfflineModelsLoading(false)
    }
  }

  function openOfflineModelModal() {
    setIsMobileSidebarOpen(false)
    setIsOfflineModelModalOpen(true)
    setOfflineModelNotice('')
    loadOfflineModels()
  }

  async function unloadOfflineModel(model) {
    const modelId = String(model?.id || '')
    if (!modelId || unloadingModelId) return
    const confirmed = window.confirm(
      'Are you sure you want to unload this model? This will free up VRAM but the model will need to reload for the next request.',
    )
    if (!confirmed) return

    setUnloadingModelId(modelId)
    setOfflineModelError('')
    setOfflineModelNotice('')
    try {
      const body = await apiPost('unsloth/models/unload', { modelId })
      const result = getEntity(body, ['result'])
      if (result?.success === false) {
        throw new Error(result.message || 'The service did not unload the model.')
      }
      setOfflineModelNotice('Model unloaded successfully')
      await loadOfflineModels()
    } catch (error) {
      const detail = getApiError(error)
      setOfflineModelError(error instanceof Error
        ? `Failed to unload model. Please try again. ${detail}`
        : 'Failed to unload model. Please try again.')
    } finally {
      setUnloadingModelId('')
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

  useEffect(() => {
    if (!isOfflineModelModalOpen) return undefined

    function handleModalKeyDown(event) {
      if (event.key === 'Escape' && !unloadingModelId) setIsOfflineModelModalOpen(false)
    }

    window.addEventListener('keydown', handleModalKeyDown)
    return () => window.removeEventListener('keydown', handleModalKeyDown)
  }, [isOfflineModelModalOpen, unloadingModelId])

  useEffect(() => {
    if (!isAsrModelDialogOpen) return undefined

    function handleAsrDialogKeyDown(event) {
      if (event.key === 'Escape' && !isStartingRecording) setIsAsrModelDialogOpen(false)
    }

    window.addEventListener('keydown', handleAsrDialogKeyDown)
    return () => window.removeEventListener('keydown', handleAsrDialogKeyDown)
  }, [isAsrModelDialogOpen, isStartingRecording])

  return (
    <main className="game-app workspace-app">
      {isMobileSidebarOpen && <button className="sidebar-backdrop" type="button" aria-label="Close navigation" onClick={() => setIsMobileSidebarOpen(false)} />}
      <aside className={`game-sidebar ${isMobileSidebarOpen ? 'sidebar-open' : ''}`}>
        <a className="game-brand" href="/chat"><span className="brand-mark">✳</span><span>person<span className="brand-accent">.</span>ai</span><span className="brand-mode">PLAY</span></a>
        <button className="new-chat-button" type="button" onClick={() => {
          setActiveConversation(null)
          setMessages([])
          setMessageHistoryLoadedFor('')
          setSelectedImage(null)
          setMessagePage(0)
          setHasMoreMessages(false)
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
          <button type="button" onClick={openOfflineModelModal}><Icon>▣</Icon> Offline Model</button>
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
          {conversationGroups.map((group) => {
            const isExpanded = expandedModelGroups[group.key] !== false
            return (
              <section className="conversation-model-group" key={group.key}>
                <button
                  className="conversation-model-header"
                  type="button"
                  aria-expanded={isExpanded}
                  onClick={() => setExpandedModelGroups((current) => ({
                    ...current,
                    [group.key]: !isExpanded,
                  }))}
                >
                  <span className={`conversation-model-chevron ${isExpanded ? 'expanded' : ''}`} aria-hidden="true">▸</span>
                  <span className="conversation-model-name">{group.displayName}</span>
                  {group.supportsVision && <span className="conversation-model-vision">Vision</span>}
                  <span className="conversation-model-count">{group.conversations.length}</span>
                </button>
                {isExpanded && (
                  <div className="conversation-model-children">
                    {group.conversations.map((conversation) => {
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
                  </div>
                )}
              </section>
            )
          })}
          {conversations.length === 0 && !resourceErrors.conversations && (
            <p className="conversation-list-empty">
              {query.trim() ? 'No conversations match your search.' : 'No conversations yet. Start a new conversation to begin.'}
            </p>
          )}
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
          {canRetry && <button className="stream-retry-button" type="button" onClick={() => streamMessage(retryContent, true, retryImage)} disabled={pending}>Retry</button>}
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss notification">×</button>
        </div>}

        {section === 'chat' && (
          <div className="workspace-content chat-section">
            <section className="selection-bar" aria-label="Conversation model configuration">
              <label>MODEL
                <select value={modelId} onChange={(event) => {
                  const nextModelId = event.target.value
                  setModelId(nextModelId)
                  const nextModel = models.find((model) => getId(model, ['modelId']) === nextModelId)
                  if (nextModel?.isOffline) {
                    setConfigId('')
                    setSelectedConfig(null)
                  }
                }} disabled={conversationSelectionLocked}>
                  <option value="">Choose a model</option>
                  {filteredModels.map((model) => <option value={getId(model, ['modelId'])} key={getId(model, ['modelId'])}>{getEntityName(model, 'Model')}</option>)}
                </select>
              </label>
              {!selectedModelIsOffline && <label>PROVIDER CONFIG
                <select value={configId} onChange={(event) => {
                  setConfigId(event.target.value)
                  setModelId('')
                  setSelectedModel(null)
                  setSelectedConfig(null)
                }} disabled={conversationSelectionLocked}>
                  <option value="">Choose a configuration</option>
                  {configs.map((config) => <option value={getId(config, ['configId', 'providerConfigId'])} key={getId(config, ['configId', 'providerConfigId'])}>{getEntityName(config, 'Configuration')}</option>)}
                </select>
              </label>}
              {activeConversation && conversationHasMessages
                ? <span className="model-lock" title="The model cannot be changed after a conversation has messages">🔒 Model locked</span>
                : activeConversation ? <button className="secondary-button" type="button" onClick={applyConversationSelection} disabled={busy || conversationSelectionLocked || !modelId || !selectedModelIsChat || (!configId && !selectedModelIsOffline)}>Apply to conversation</button> : null}
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
                  <button className="workspace-primary-button" type="submit" disabled={busy || !modelId || !selectedModelIsChat || (!configId && !selectedModelIsOffline)}>{busy ? 'Starting…' : 'Start conversation'} <span>↗</span></button>
                </form>
                {(!filteredModels.length || (!configs.length && !selectedModelIsOffline)) && <p className="setup-hint">Choose an available chat model and add a provider configuration if required. Offline models do not need one.</p>}
                {renderError('configs')}{renderError('models')}
              </section>
            ) : (
              <>
                <section className="conversation-heading">
                  <div><span className="arena-kicker">ACTIVE CONVERSATION</span><h1>{getEntityName(activeConversation, 'Conversation')}</h1></div>
                  <button className="secondary-button" type="button" onClick={() => {
                    setActiveConversation(null)
                    setMessages([])
                    setMessageHistoryLoadedFor('')
                    setSelectedImage(null)
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
                        {message.imageSrc && (
                          <img className="message-image" src={message.imageSrc} alt="Image attached to this message" />
                        )}
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
                  <div className={`chat-composer-row ${isComposerExpanded ? 'expanded' : ''}`}>
                    <textarea ref={composerRef} value={draft} onChange={(event) => {
                      const nextDraft = event.target.value
                      setDraft(nextDraft)
                      if (nextDraft && event.currentTarget.scrollHeight > 42) setIsComposerExpanded(true)
                      else if (!nextDraft) setIsComposerExpanded(false)
                    }} onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault()
                        event.currentTarget.form.requestSubmit()
                      }
                    }} placeholder="Message your AI..." aria-label="Message your AI" rows={1} maxLength={2000} />
                    <div className="composer-controls">
                    <div className="attachment-menu-wrap" ref={attachmentMenuRef}>
                      <input
                        ref={imageInputRef}
                        className="image-file-input"
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        onChange={selectImage}
                        aria-label="Choose an image"
                      />
                      <button
                        className={`composer-icon-button attachment-button ${isAttachmentMenuOpen ? 'active' : ''}`}
                        type="button"
                        aria-label="Add attachments"
                        aria-expanded={isAttachmentMenuOpen}
                        title="Add attachments"
                        onClick={() => setIsAttachmentMenuOpen((open) => !open)}
                      >+</button>
                      {isAttachmentMenuOpen && (
                        <div className="attachment-menu" role="menu" aria-label="Attachments">
                          <button
                            type="button"
                            role="menuitem"
                            disabled={!supportsVision || pending || imageLoading}
                            title={!supportsVision ? 'Image uploads require a vision-capable model.' : undefined}
                            onClick={() => {
                              setIsAttachmentMenuOpen(false)
                              if (supportsVision) imageInputRef.current?.click()
                            }}
                          >
                            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                              <rect x="3.5" y="4" width="17" height="16" rx="3" stroke="currentColor" strokeWidth="1.7" />
                              <circle cx="9" cy="10" r="1.7" stroke="currentColor" strokeWidth="1.5" />
                              <path d="m5 17 4.5-4 3.2 2.7 2.5-2 3.8 3.3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                            <span className="attachment-menu-copy">
                              <strong>Photos & files</strong>
                              <small>{supportsVision ? 'Add an image to your message' : 'Requires a vision model'}</small>
                            </span>
                          </button>
                        </div>
                      )}
                    </div>
                    <button
                      className={`composer-icon-button thinking-control ${thinkingEnabled ? 'active' : ''}`}
                      type="button"
                      role="switch"
                      aria-checked={thinkingEnabled}
                      aria-label={`Thinking ${thinkingEnabled ? 'on' : 'off'}`}
                      title={`Thinking ${thinkingEnabled ? 'on' : 'off'}`}
                      onClick={() => updateThinkingPreference(!thinkingEnabled)}
                    >
                      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path d="M9 18h6m-5 3h4m-2-19a7 7 0 0 0-4 12.75c.6.43 1 1.06 1 1.75h6c0-.69.4-1.32 1-1.75A7 7 0 0 0 12 2Z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                        <path className="thinking-rays" d="M12 5.5v3m-3.5 0 1.2 1.2m7.3-1.2-1.2 1.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                    </button>
                    <button
                      className={`composer-icon-button internet-control ${internetEnabled ? 'active' : ''}`}
                      type="button"
                      role="switch"
                      aria-checked={internetEnabled}
                      aria-label={`Internet ${internetEnabled ? 'on' : 'off'}`}
                      title={`Internet ${internetEnabled ? 'on' : 'off'}`}
                      onClick={() => updateInternetPreference(!internetEnabled)}
                    >
                      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" />
                        <path d="M3.5 12h17M12 3c2.2 2.4 3.3 5.4 3.3 9s-1.1 6.6-3.3 9c-2.2-2.4-3.3-5.4-3.3-9S9.8 5.4 12 3Z" stroke="currentColor" strokeWidth="1.5" />
                      </svg>
                    </button>
                    <button
                      className={`composer-icon-button microphone-button ${isRecording ? 'recording' : ''}`}
                      type="button"
                      onClick={toggleAudioRecording}
                      disabled={pending || isStartingRecording || isTranscribing}
                      aria-label={isRecording ? 'Stop recording and transcribe' : 'Record a voice message'}
                      title={isRecording ? 'Stop recording and transcribe' : 'Record a voice message'}
                    >
                      {isRecording
                        ? <>
                          <span className="microphone-stop-icon" aria-hidden="true">×</span>
                          <span className="recording-duration">
                            {String(Math.floor(recordingSeconds / 60)).padStart(2, '0')}:{String(recordingSeconds % 60).padStart(2, '0')}
                          </span>
                        </>
                        : <svg className="microphone-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <rect x="9" y="3" width="6" height="12" rx="3" stroke="currentColor" strokeWidth="1.8" />
                          <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3m-4 0h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                        </svg>}
                    </button>
                    {pending
                      ? <button type="button" className="send-button stop-button" onClick={cancelStream} aria-label="Stop response">■</button>
                      : <button type="submit" className="send-button" disabled={(!draft.trim() && !selectedImage) || busy || imageLoading} aria-label="Send message">↑</button>}
                    </div>
                  </div>
                  {selectedImage && (
                    <div className="composer-image-preview">
                      <img src={selectedImage.previewUrl} alt={`Selected image: ${selectedImage.name}`} />
                      <button type="button" onClick={() => {
                        setSelectedImage(null)
                        if (imageInputRef.current) imageInputRef.current.value = ''
                      }} aria-label="Remove selected image">×</button>
                    </div>
                  )}
                  {(asrModelsLoading || isStartingRecording || isTranscribing) && (
                    <span className="transcription-status" role="status">
                      {asrModelsLoading ? 'Finding speech models…' : isTranscribing ? 'Transcribing…' : 'Starting microphone…'}
                    </span>
                  )}
                  {transcriptionError && <p className="transcription-error" role="alert">{transcriptionError}</p>}
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
      {isOfflineModelModalOpen && (
        <div
          className="offline-model-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !unloadingModelId) setIsOfflineModelModalOpen(false)
          }}
        >
          <section
            className="offline-model-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="offline-model-title"
            aria-busy={offlineModelsLoading}
          >
            <header className="offline-model-header">
              <div>
                <span className="arena-kicker">UNSLOTH INFERENCE</span>
                <h2 id="offline-model-title">Offline Model Management</h2>
              </div>
              <button
                type="button"
                className="offline-model-close"
                aria-label="Close offline model management"
                onClick={() => setIsOfflineModelModalOpen(false)}
                disabled={Boolean(unloadingModelId)}
              >×</button>
            </header>
            {offlineModelError && <p className="offline-model-feedback error" role="alert">{offlineModelError}</p>}
            {offlineModelNotice && <p className="offline-model-feedback success" role="status">{offlineModelNotice}</p>}
            <div className="offline-model-list" aria-live="polite">
              {offlineModelsLoading
                ? <p className="offline-model-empty">Loading model status…</p>
                : offlineModels.length === 0 && !offlineModelError
                  ? <p className="offline-model-empty">No Unsloth models found.</p>
                  : offlineModels.map((model, index) => {
                    const modelId = String(model?.id || '')
                    const shortName = modelId.split('/').pop()?.replace(/-(?:uncensored|gguf).*$/i, '') || 'Unknown model'
                    const loaded = model?.loaded === true || String(model?.statusValue || '').toLowerCase() === 'loaded'
                    return (
                      <article className="offline-model-card" key={modelId || `model-${index}`}>
                        <div className="offline-model-card-details">
                          <strong title={modelId || undefined}>{shortName}</strong>
                          <span>{model?.quant || 'Quantization unavailable'}</span>
                        </div>
                        <span className={`offline-model-status ${loaded ? 'loaded' : 'unloaded'}`}>
                          <i aria-hidden="true" /> {loaded ? 'Loaded' : 'Unloaded'}
                        </span>
                        {loaded && (
                          <button
                            className="offline-model-unload"
                            type="button"
                            onClick={() => unloadOfflineModel(model)}
                            disabled={!modelId || offlineModelsLoading || Boolean(unloadingModelId)}
                          >
                            {unloadingModelId === modelId ? 'Unloading…' : 'Unload'}
                          </button>
                        )}
                      </article>
                    )
                  })}
            </div>
            <footer className="offline-model-footer">
              <button className="secondary-button" type="button" onClick={loadOfflineModels} disabled={offlineModelsLoading || Boolean(unloadingModelId)}>
                {offlineModelsLoading ? 'Refreshing…' : 'Refresh'}
              </button>
            </footer>
          </section>
        </div>
      )}
      {isAsrModelDialogOpen && (
        <div
          className="offline-model-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setIsAsrModelDialogOpen(false)
          }}
        >
          <section
            className="offline-model-modal asr-model-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="asr-model-title"
          >
            <header className="offline-model-header">
              <div>
                <span className="arena-kicker">VOICE INPUT</span>
                <h2 id="asr-model-title">Choose a speech model</h2>
              </div>
              <button
                type="button"
                className="offline-model-close"
                aria-label="Close speech model selection"
                onClick={() => setIsAsrModelDialogOpen(false)}
              >×</button>
            </header>
            <p className="asr-model-dialog-hint">Choose which model should transcribe your recording.</p>
            <div className="asr-model-options">
              {asrModels.map((model) => (
                <button
                  type="button"
                  className="asr-model-option"
                  key={getId(model, ['modelId'])}
                  onClick={() => chooseAsrModel(model)}
                >
                  <span className="asr-model-option-icon" aria-hidden="true">◉</span>
                  <span className="asr-model-option-name">
                    <strong>{getEntityName(model, 'Speech model')}</strong>
                    <small>{model.providerDisplayName || model.providerCode || 'Speech-to-text'}</small>
                  </span>
                  <span className="asr-model-option-arrow" aria-hidden="true">→</span>
                </button>
              ))}
            </div>
            <footer className="offline-model-footer">
              <button className="secondary-button" type="button" onClick={() => setIsAsrModelDialogOpen(false)}>Cancel</button>
            </footer>
          </section>
        </div>
      )}
    </main>
  )
}
