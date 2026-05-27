import { parseShipEquipHtml } from './ship-equip-parser.js'
import { fetchShipText } from './ship-request.js'
import { getEquipDataFile, readEquipData } from './equip-store.js'
import {
  ensureCharacterDirs,
  loadShipEquipBuildState,
  loadShipInstallDict,
  shipEquipExists,
  writeShipEquipBuildState,
  writeShipEquipData
} from './ship-store.js'
import { resolveShipBuildEntry } from './ship-cache-builder.js'

const SHIP_PAGE_URL = 'https://wiki.biligame.com/blhx/'

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

async function enrichEquipRef(ref) {
  try {
    const equip = await readEquipData(ref.full_name)
    return {
      ...ref,
      local_image: equip.local_image || equip.image || '',
      equip_data_path: getEquipDataFile(ref.full_name)
    }
  } catch {
    return ref
  }
}

async function enrichShipEquipData(parsed, entry) {
  const shipName = entry.original_name || parsed.page_title || ''
  const special = []
  for (const item of parsed.special_recommendations ?? []) {
    special.push(item)
  }

  const columns = []
  for (const column of parsed.general_recommendation?.columns ?? []) {
    const rows = []
    for (const row of column.rows ?? []) {
      const equipRefs = []
      for (const ref of row.equip_refs ?? []) {
        equipRefs.push(await enrichEquipRef(ref))
      }
      rows.push({
        ...row,
        equip_refs: equipRefs
      })
    }
    columns.push({
      ...column,
      rows
    })
  }

  const mergedRows = []
  for (const row of parsed.general_recommendation?.rows ?? []) {
    const cells = []
    for (const cell of row.cells ?? []) {
      if (!cell) {
        cells.push(null)
        continue
      }
      const equipRefs = []
      for (const ref of cell.equip_refs ?? []) {
        equipRefs.push(await enrichEquipRef(ref))
      }
      cells.push({
        ...cell,
        equip_refs: equipRefs
      })
    }
    mergedRows.push({
      ...row,
      cells
    })
  }

  return {
    ...parsed,
    ship_id: entry.ship_id || '',
    ship_name: shipName,
    original_name: shipName,
    alias_name: entry.alias_name || '',
    matched_internal_name: entry.matched_internal_name || '',
    release_date: entry.release_date || '',
    source: {
      ...parsed.source,
      page_url: parsed.source.page_url || `${SHIP_PAGE_URL}${encodeURIComponent(entry.original_name)}`
    },
    general_recommendation: {
      ...parsed.general_recommendation,
      columns,
      rows: mergedRows
    },
    generated_at: new Date().toISOString()
  }
}

async function buildSingleShipEquip(entry, options = {}) {
  const { retries = 4, retryDelayMs = 2500 } = options
  const pageUrl = `${SHIP_PAGE_URL}${encodeURIComponent(entry.original_name)}`
  const { data: html } = await fetchShipText(pageUrl, { retries, retryDelayMs })
  const parsed = parseShipEquipHtml(html, { pageUrl })
  return enrichShipEquipData(parsed, entry)
}

export async function buildShipEquipByName(shipName, options = {}) {
  const { retries = 4, retryDelayMs = 2500 } = options
  await ensureCharacterDirs()

  const entry = await resolveShipBuildEntry(shipName)
  const equip = await buildSingleShipEquip(entry, { retries, retryDelayMs })
  const filePath = await writeShipEquipData(equip.original_name, equip)

  const state = await loadShipEquipBuildState()
  const completedSet = new Set(state.completed ?? [])
  completedSet.add(equip.original_name)
  if (entry.original_name && entry.original_name !== equip.original_name) {
    completedSet.add(entry.original_name)
    delete state.failed?.[entry.original_name]
  }
  delete state.failed?.[equip.original_name]
  state.completed = Array.from(completedSet)
  await writeShipEquipBuildState(state)

  return {
    equip,
    entry,
    filePath
  }
}

export async function buildShipEquipCache(options = {}) {
  const {
    force = false,
    only = [],
    limit = Number.POSITIVE_INFINITY,
    delayMs = 5000,
    retries = 4,
    retryDelayMs = 2500
  } = options

  await ensureCharacterDirs()
  const state = await loadShipEquipBuildState()
  const completedSet = new Set(state.completed ?? [])
  const entries = filterShipEntries(normalizeShipEntries(await loadShipInstallDict()), only)
  const pending = []

  for (const entry of entries) {
    if (force || (!completedSet.has(entry.original_name) && !await shipEquipExists(entry.original_name))) {
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
      const equip = await buildSingleShipEquip(entry, { retries, retryDelayMs })
      await writeShipEquipData(equip.original_name, equip)

      finished += 1
      completedSet.add(equip.original_name)
      delete state.failed?.[entry.original_name]
      delete state.failed?.[equip.original_name]
      state.completed = Array.from(completedSet)
      await writeShipEquipBuildState(state)
      console.info(`[build:ship-equip] 完成 ${finished}/${pending.length}: ${equip.original_name}`)
    } catch (error) {
      failed += 1
      state.failed ??= {}
      state.failed[entry.original_name] = String(error?.message ?? error)
      state.completed = Array.from(completedSet)
      await writeShipEquipBuildState(state)
      console.error('[build:ship-equip] 抓取失败:', error)
    }

    if (index < pending.length - 1 && delayMs > 0) {
      console.info(`[build:ship-equip] 等待 ${delayMs}ms 后继续抓取下一个页面...`)
      await sleep(delayMs)
    }
  }

  return {
    count: finished,
    failed,
    pending: pending.length
  }
}
