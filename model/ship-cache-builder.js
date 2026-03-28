import { parseShipPage } from './wiki-parser.js'
import { invalidateShipCache, normalizeKeyword } from './cache-store.js'
import { fetchShipText } from './ship-request.js'
import {
  ensureCharacterDirs,
  getExpectedShipLocalImagePath,
  loadShipBuildState,
  loadShipInstallDict,
  readShipData,
  shipDataExists,
  writeShipBuildState,
  writeShipData
} from './ship-store.js'

const SHIP_PAGE_URL = 'https://wiki.biligame.com/blhx/'

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function splitKeywords(text) {
  return String(text ?? '')
    .split(/[\s·・･‧()（）[\]【】/_./\\-]+/)
    .map((item) => normalizeKeyword(item))
    .filter(Boolean)
}

function buildSearchKeywords(ship) {
  return unique([
    normalizeKeyword(ship.name),
    normalizeKeyword(ship.code),
    normalizeKeyword(ship.pageTitle),
    normalizeKeyword(ship.original_name),
    normalizeKeyword(ship.matched_internal_name),
    ...splitKeywords(ship.name),
    ...splitKeywords(ship.code),
    ...splitKeywords(ship.pageTitle),
    ...splitKeywords(ship.original_name),
    ...splitKeywords(ship.alias_name)
  ])
}

function readOptionList(values) {
  return new Set(values.map((item) => String(item).trim()).filter(Boolean))
}

function normalizeShipEntries(entries) {
  return entries.filter((entry) => String(entry?.ship_id ?? '').trim() !== '')
}

function filterShipEntries(entries, onlyList) {
  if (!onlyList.length) {
    return entries
  }

  const querySet = readOptionList(onlyList)
  return entries.filter((entry) => {
    return querySet.has(entry.original_name)
      || querySet.has(entry.ship_id)
      || querySet.has(entry.matched_internal_name)
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function transformShipData(parsed, entry) {
  const wikiImage = parsed.image || ''
  const shipName = parsed.pageTitle || entry.original_name || parsed.name || ''
  const localImage = getExpectedShipLocalImagePath(shipName, entry.matched_internal_name)

  return {
    ...parsed,
    id: entry.ship_id || parsed.id || shipName,
    ship_id: entry.ship_id || '',
    name: shipName,
    original_name: shipName,
    alias_name: entry.alias_name || '',
    matched_internal_name: entry.matched_internal_name || '',
    release_date: entry.release_date || '',
    image: localImage,
    wiki_image: wikiImage,
    searchKeywords: buildSearchKeywords({
      ...parsed,
      name: shipName,
      original_name: shipName,
      matched_internal_name: entry.matched_internal_name,
      alias_name: entry.alias_name
    }),
    cacheUpdatedAt: new Date().toISOString(),
    cacheVersion: 2,
    cacheSource: SHIP_PAGE_URL
  }
}

async function buildSingleShip(entry, options = {}) {
  const { retries = 4, retryDelayMs = 2500 } = options
  const pageUrl = `${SHIP_PAGE_URL}${encodeURIComponent(entry.original_name)}`
  const { data: html } = await fetchShipText(pageUrl, { retries, retryDelayMs })
  const parsed = parseShipPage(html, { pageUrl })
  return transformShipData(parsed, entry)
}

function buildFallbackShipEntry(shipName, existingShip = null) {
  return {
    ship_id: existingShip?.ship_id || existingShip?.id || '',
    original_name: existingShip?.original_name || existingShip?.name || shipName,
    alias_name: existingShip?.alias_name || '',
    matched_internal_name: existingShip?.matched_internal_name || '',
    release_date: existingShip?.release_date || ''
  }
}

function matchShipEntry(entries, keyword) {
  const normalized = normalizeKeyword(keyword)
  return entries.find((entry) => {
    return normalized === normalizeKeyword(entry.original_name)
      || normalized === normalizeKeyword(entry.ship_id)
      || normalized === normalizeKeyword(entry.matched_internal_name)
      || normalized === normalizeKeyword(entry.alias_name)
  }) ?? null
}

export async function resolveShipBuildEntry(shipName) {
  const normalizedName = String(shipName ?? '').trim()
  const entries = normalizeShipEntries(await loadShipInstallDict())
  const matchedEntry = matchShipEntry(entries, normalizedName)
  if (matchedEntry) {
    return matchedEntry
  }

  try {
    const existingShip = await readShipData(normalizedName)
    return buildFallbackShipEntry(normalizedName, existingShip)
  } catch {
    return buildFallbackShipEntry(normalizedName)
  }
}

export async function buildShipDataByName(shipName, options = {}) {
  const { retries = 4, retryDelayMs = 2500 } = options
  await ensureCharacterDirs()

  const entry = await resolveShipBuildEntry(shipName)
  const ship = await buildSingleShip(entry, { retries, retryDelayMs })
  const filePath = await writeShipData(ship.original_name, ship)

  const state = await loadShipBuildState()
  const completedSet = new Set(state.completed ?? [])
  completedSet.add(ship.original_name)
  if (entry.original_name && entry.original_name !== ship.original_name) {
    completedSet.add(entry.original_name)
    delete state.failed?.[entry.original_name]
  }
  delete state.failed?.[ship.original_name]
  state.completed = Array.from(completedSet)
  await writeShipBuildState(state)
  invalidateShipCache()

  return {
    ship,
    entry,
    filePath
  }
}

export async function buildShipCache(options = {}) {
  const {
    force = false,
    only = [],
    limit = Number.POSITIVE_INFINITY,
    delayMs = 5000,
    retries = 4,
    retryDelayMs = 2500
  } = options

  await ensureCharacterDirs()
  const state = await loadShipBuildState()
  const completedSet = new Set(state.completed ?? [])
  const entries = filterShipEntries(normalizeShipEntries(await loadShipInstallDict()), only)
  const pending = []

  for (const entry of entries) {
    if (force || (!completedSet.has(entry.original_name) && !await shipDataExists(entry.original_name))) {
      pending.push(entry)
      if (pending.length >= limit) {
        break
      }
    }
  }

  let finished = 0
  let failed = 0

  for (let index = 0; index < pending.length; index += 1) {
    const entry = pending[index]
    try {
      const ship = await buildSingleShip(entry, { retries, retryDelayMs })
      await writeShipData(ship.original_name, ship)
      invalidateShipCache()

      finished += 1
      completedSet.add(ship.original_name)
      delete state.failed?.[entry.original_name]
      delete state.failed?.[ship.original_name]
      state.completed = Array.from(completedSet)
      await writeShipBuildState(state)
      console.info(`[build:ships] 完成 ${finished}/${pending.length}: ${ship.original_name}`)
    } catch (error) {
      failed += 1
      state.failed ??= {}
      state.failed[entry.original_name] = String(error?.message ?? error)
      state.completed = Array.from(completedSet)
      await writeShipBuildState(state)
      console.error('[build:ships] 抓取失败:', error)
    }

    if (index < pending.length - 1 && delayMs > 0) {
      console.info(`[build:ships] 等待 ${delayMs}ms 后继续抓取下一个页面...`)
      await sleep(delayMs)
    }
  }

  return {
    count: finished,
    failed,
    pending: pending.length
  }
}
