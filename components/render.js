import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN_NAME = 'azurlane-plugin'
import { buildShipCardViewModel } from '../model/ship-card-data.js'
import { buildShipEquipCardViewModel } from '../model/ship-equip-card-data.js'

const RENDER_TEMPLATE_VERSION = {
  ship: 'ship-card-v1',
  skill: 'ship-card-skill-v1',
  equip: 'ship-equip-card-v1'
}

const IMAGE_CACHE_ROOT = path.resolve('temp', 'render-cache')
const IMAGE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const fallbackRenderCache = new Map()
let cacheCleanupPromise

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
  const saveId = buildSaveId([
    PLUGIN_NAME,
    RENDER_TEMPLATE_VERSION[mode] || RENDER_TEMPLATE_VERSION.ship,
    getShipIdentity(ship),
    ship?.cacheUpdatedAt || cacheMeta?.generatedAt || 'static'
  ])

  return {
    ...view,
    saveId,
    tplFile: `./plugins/${PLUGIN_NAME}/resources/wiki/ship-card.html`,
    defaultLayout: `./plugins/${PLUGIN_NAME}/resources/common/layout/default.html`,
    _res_path: `./plugins/${PLUGIN_NAME}/resources/`,
    sys: {
      scale: 'data-scale="1.15"',
      copyright: `AzurLane Wiki Cache · ${cacheMeta?.generatedAt ?? 'local'}`
    }
  }
}

function createShipEquipRenderData({ ship, equip, keyword, alternatives, cacheMeta }) {
  const view = buildShipEquipCardViewModel({ ship, equip, keyword, alternatives, cacheMeta })
  const saveId = buildSaveId([
    PLUGIN_NAME,
    RENDER_TEMPLATE_VERSION.equip,
    getShipIdentity(ship),
    ship?.cacheUpdatedAt || cacheMeta?.generatedAt || 'ship-static',
    equip?.generated_at || 'equip-static'
  ])

  return {
    ...view,
    saveId,
    tplFile: `./plugins/${PLUGIN_NAME}/resources/wiki/ship-equip-card.html`,
    defaultLayout: `./plugins/${PLUGIN_NAME}/resources/common/layout/default.html`,
    _res_path: `./plugins/${PLUGIN_NAME}/resources/`,
    sys: {
      scale: 'data-scale="1.0"',
      copyright: `AzurLane Wiki Cache · ${view.generated_at_display || cacheMeta?.generatedAt || 'local'}`
    }
  }
}

async function renderByRuntime(e, rendererKey, data) {
  if (typeof e?.runtime?.render !== 'function') {
    return null
  }

  try {
    return await e.runtime.render(PLUGIN_NAME, rendererKey, data, { retType: 'default' })
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

  const rendered = await renderByRenderer(rendererKey, data)
  if (rendered !== null && rendered !== false) {
    const cachedFile = await persistRenderedImage(data.saveId, rendered)
    if (cachedFile) {
      return wrapRenderedImage(pathToFileURL(cachedFile).href)
    }

    rememberFallbackRender(data.saveId, rendered)
    return wrapRenderedImage(rendered)
  }

  const runtimeRendered = await renderByRuntime(e, rendererKey, data)
  if (runtimeRendered !== null && runtimeRendered !== false) {
    const cachedFile = await persistRenderedImage(data.saveId, runtimeRendered)
    if (cachedFile) {
      return wrapRenderedImage(pathToFileURL(cachedFile).href)
    }

    return runtimeRendered
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
