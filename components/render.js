import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN_NAME = 'azurlane-plugin'
import { buildShipCardViewModel } from '../model/ship-card-data.js'
import { buildShipEquipCardViewModel } from '../model/ship-equip-card-data.js'
import { buildEquipCardViewModel } from '../model/equip-card-data.js'

const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const RESOURCE_ROOT = path.join(PLUGIN_ROOT, 'resources')
const RESOURCE_ROOT_URL = `${pathToFileURL(RESOURCE_ROOT).href.replace(/\/?$/, '/')}`
const DEFAULT_LAYOUT_FILE = path.join(RESOURCE_ROOT, 'common', 'layout', 'default.html')

const RENDER_TEMPLATE_VERSION = {
  ship: 'ship-card-v1',
  skill: 'ship-card-skill-v1',
  equip: 'ship-equip-card-v4',
  equipItem: 'equip-card-v2'
}

const IMAGE_CACHE_ROOT = path.join(PLUGIN_ROOT, 'temp', 'render-cache')
const IMAGE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const fallbackRenderCache = new Map()
let cacheCleanupPromise

function buildScaleStyle(scale = 1) {
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1
  return `style="transform:scale(${safeScale});transform-origin:0 0;"`
}

function normalizeSaveIdPart(value) {
  return String(value ?? '')
    .trim()
    .replace(/[^0-9a-z\u4e00-\u9fa5]+/gi, '-')
    .replace(/^-+|-+$/g, '')
}

function buildSaveId(parts) {
  const normalized = parts.map(normalizeSaveIdPart).filter(Boolean)
  return normalized.length ? normalized.join('--') : `${PLUGIN_NAME}-render`
}

function stableSerialize(value) {
  if (value === null || value === undefined) {
    return 'null'
  }

  const type = typeof value
  if (type === 'number' || type === 'boolean') {
    return JSON.stringify(value)
  }

  if (type === 'string') {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`
  }

  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort((a, b) => a.localeCompare(b))

  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`
}

function stripCacheNoise(payload) {
  if (payload === null || payload === undefined) {
    return payload
  }

  if (Array.isArray(payload)) {
    return payload.map((item) => stripCacheNoise(item))
  }

  if (typeof payload !== 'object') {
    return payload
  }

  const output = {}
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'keyword' || key === 'alternatives') {
      continue
    }

    output[key] = stripCacheNoise(value)
  }

  return output
}

function buildPayloadCacheId({ rendererKey, templateVersion, identity, payload }) {
  const normalizedPayload = stripCacheNoise(payload)
  const digest = createHash('sha256')
    .update(stableSerialize({ rendererKey, templateVersion, payload: normalizedPayload }))
    .digest('hex')
    .slice(0, 24)

  return buildSaveId([PLUGIN_NAME, rendererKey, templateVersion, identity, digest])
}

function getShipIdentity(ship) {
  return ship?.ship_id || ship?.id || ship?.name || 'unknown-ship'
}

function getImageCacheFile(saveId) {
  const hashed = createHash('sha1').update(String(saveId)).digest('hex')
  return path.join(IMAGE_CACHE_ROOT, `${hashed}.png`)
}

async function ensureImageCacheDir() {
  await fs.mkdir(IMAGE_CACHE_ROOT, { recursive: true })
}

async function pruneExpiredImageCache() {
  try {
    await ensureImageCacheDir()
    const entries = await fs.readdir(IMAGE_CACHE_ROOT, { withFileTypes: true })
    const now = Date.now()

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue
      }

      const filePath = path.join(IMAGE_CACHE_ROOT, entry.name)
      try {
        const stat = await fs.stat(filePath)
        if (now - stat.mtimeMs > IMAGE_CACHE_TTL_MS) {
          await fs.unlink(filePath)
        }
      } catch {
        continue
      }
    }
  } catch {
    return
  }
}

async function ensureImageCacheReady() {
  cacheCleanupPromise ??= pruneExpiredImageCache()
  await cacheCleanupPromise
}

async function readFreshCachedImage(saveId) {
  if (!saveId) {
    return ''
  }

  const filePath = getImageCacheFile(saveId)
  try {
    const stat = await fs.stat(filePath)
    if (Date.now() - stat.mtimeMs > IMAGE_CACHE_TTL_MS) {
      return ''
    }
    return filePath
  } catch {
    return ''
  }
}

async function persistRenderedImage(saveId, image) {
  if (!saveId || !image) {
    return ''
  }

  const cacheFile = getImageCacheFile(saveId)
  await ensureImageCacheDir()

  if (Buffer.isBuffer(image)) {
    await fs.writeFile(cacheFile, image)
    return cacheFile
  }

  if (image && typeof image === 'object' && typeof image.file === 'string') {
    return persistRenderedImage(saveId, image.file)
  }

  if (image && typeof image === 'object' && image.data && typeof image.data.file === 'string') {
    return persistRenderedImage(saveId, image.data.file)
  }

  if (typeof image !== 'string') {
    return ''
  }

  const value = image.trim()
  if (!value) {
    return ''
  }

  if (value.startsWith('base64://')) {
    await fs.writeFile(cacheFile, Buffer.from(value.slice('base64://'.length), 'base64'))
    return cacheFile
  }

  const dataUrlMatch = value.match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/i)
  if (dataUrlMatch) {
    await fs.writeFile(cacheFile, Buffer.from(dataUrlMatch[1], 'base64'))
    return cacheFile
  }

  let sourcePath = ''
  if (/^file:/i.test(value)) {
    sourcePath = fileURLToPath(value)
  } else {
    const resolved = path.isAbsolute(value) ? value : path.resolve(value)
    try {
      await fs.access(resolved)
      sourcePath = resolved
    } catch {
      sourcePath = ''
    }
  }

  if (!sourcePath) {
    return ''
  }

  await fs.copyFile(sourcePath, cacheFile)
  return cacheFile
}

function rememberFallbackRender(saveId, image) {
  if (!saveId) {
    return
  }

  fallbackRenderCache.set(saveId, image)
  if (fallbackRenderCache.size <= 50) {
    return
  }

  const oldestKey = fallbackRenderCache.keys().next().value
  if (oldestKey) {
    fallbackRenderCache.delete(oldestKey)
  }
}

function wrapRenderedImage(image) {
  return globalThis.segment?.image?.(image) ?? image
}

function createShipCardRenderData({ ship, mode, keyword, alternatives, cacheMeta }) {
  const view = buildShipCardViewModel({ ship, mode, keyword, alternatives, cacheMeta })
  const templateVersion = RENDER_TEMPLATE_VERSION[mode] || RENDER_TEMPLATE_VERSION.ship
  const saveId = buildPayloadCacheId({
    rendererKey: 'wiki/ship-card',
    templateVersion,
    identity: getShipIdentity(ship),
    payload: view
  })

  return {
    ...view,
    saveId,
    tplFile: `./plugins/${PLUGIN_NAME}/resources/wiki/ship-card.html`,
    defaultLayout: `./plugins/${PLUGIN_NAME}/resources/common/layout/default.html`,
    _res_path: `./plugins/${PLUGIN_NAME}/resources/`,
    sys: {
      scale: buildScaleStyle(1),
      copyright: `AzurLane Wiki Cache · ${cacheMeta?.generatedAt ?? 'local'}`
    }
  }
}

function createShipEquipRenderData({ ship, equip, keyword, alternatives, cacheMeta }) {
  const view = buildShipEquipCardViewModel({ ship, equip, keyword, alternatives, cacheMeta })
  const saveId = buildPayloadCacheId({
    rendererKey: 'wiki/ship-equip-card',
    templateVersion: RENDER_TEMPLATE_VERSION.equip,
    identity: getShipIdentity(ship),
    payload: view
  })

  return {
    ...view,
    saveId,
    tplFile: `./plugins/${PLUGIN_NAME}/resources/wiki/ship-equip-card.html`,
    defaultLayout: `./plugins/${PLUGIN_NAME}/resources/common/layout/default.html`,
    _res_path: `./plugins/${PLUGIN_NAME}/resources/`,
    sys: {
      scale: buildScaleStyle(1),
      copyright: `AzurLane Wiki Cache · ${view.generated_at_display || cacheMeta?.generatedAt || 'local'}`
    }
  }
}

function createEquipRenderData({ equip, entry, keyword, alternatives }) {
  const view = buildEquipCardViewModel({ equip, entry, keyword, alternatives })
  const saveId = buildPayloadCacheId({
    rendererKey: 'wiki/equip-card',
    templateVersion: RENDER_TEMPLATE_VERSION.equipItem,
    identity: view.full_name || view.equip_name || 'unknown-equip',
    payload: view
  })

  return {
    ...view,
    saveId,
    tplFile: `./plugins/${PLUGIN_NAME}/resources/wiki/equip-card.html`,
    defaultLayout: `./plugins/${PLUGIN_NAME}/resources/common/layout/default.html`,
    _res_path: `./plugins/${PLUGIN_NAME}/resources/`,
    sys: {
      scale: buildScaleStyle(1),
      copyright: `AzurLane Wiki Cache · ${view.generated_at_display || 'local'}`
    }
  }
}

async function renderByRuntime(e, rendererKey, data) {
  if (typeof e?.runtime?.render !== 'function') {
    return null
  }

  try {
    return await e.runtime.render(PLUGIN_NAME, rendererKey, data, {
      retType: 'default',
      beforeRender({ data: runtimeData = {} }) {
        return {
          ...runtimeData,
          ...data,
          _res_path: RESOURCE_ROOT_URL,
          defaultLayout: DEFAULT_LAYOUT_FILE
        }
      }
    })
  } catch (error) {
    globalThis.logger?.warn?.(`[azurlane-plugin] runtime.render 失败，已回退 Renderer.render: ${rendererKey}`, error)
    return null
  }
}

async function renderByRenderer(rendererKey, data) {
  const renderer = globalThis.Renderer?.getRenderer?.()
  if (!renderer?.render) {
    return null
  }

  return renderer.render(rendererKey, data)
}

async function renderByTemplate(e, rendererKey, data) {
  await ensureImageCacheReady()

  const localCacheFile = await readFreshCachedImage(data.saveId)
  if (localCacheFile) {
    return wrapRenderedImage(pathToFileURL(localCacheFile).href)
  }

  if (data.saveId && fallbackRenderCache.has(data.saveId)) {
    return wrapRenderedImage(fallbackRenderCache.get(data.saveId))
  }

  const runtimeRendered = await renderByRuntime(e, rendererKey, data)
  if (runtimeRendered !== null && runtimeRendered !== false) {
    const cachedFile = await persistRenderedImage(data.saveId, runtimeRendered)
    if (cachedFile) {
      return wrapRenderedImage(pathToFileURL(cachedFile).href)
    }

    rememberFallbackRender(data.saveId, runtimeRendered)
    return wrapRenderedImage(runtimeRendered)
  }

  const rendered = await renderByRenderer(rendererKey, data)
  if (rendered !== null && rendered !== false) {
    const cachedFile = await persistRenderedImage(data.saveId, rendered)
    if (cachedFile) {
      return wrapRenderedImage(pathToFileURL(cachedFile).href)
    }

    rememberFallbackRender(data.saveId, rendered)
    return wrapRenderedImage(rendered)
  }

  globalThis.logger?.error?.('[azurlane-plugin] 未找到可用的 Renderer 渲染器')
  return false
}

export async function renderShipCard(e, payload) {
  if (!e) {
    return false
  }

  const data = createShipCardRenderData(payload)
  return renderByTemplate(e, 'wiki/ship-card', data)
}

export async function renderShipEquipCard(e, payload) {
  if (!e) {
    return false
  }

  const data = createShipEquipRenderData(payload)
  return renderByTemplate(e, 'wiki/ship-equip-card', data)
}

export async function renderEquipCard(e, payload) {
  if (!e) {
    return false
  }

  const data = createEquipRenderData(payload)
  return renderByTemplate(e, 'wiki/equip-card', data)
}
