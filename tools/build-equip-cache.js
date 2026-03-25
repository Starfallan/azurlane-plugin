#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { parseEquipHtml } from '../model/equip-parser.js'
import { fetchWithRetry } from '../model/equip-request.js'
import {
  cleanupEquipImageDir,
  downloadEquipImage,
  ensureEquipDirs,
  getEquipDataFile,
  loadEquipBuildState,
  loadEquipIndex,
  resolveReferencedEquipImagePath,
  writeEquipData,
  writeEquipBuildState,
  writeEquipHtmlCache
} from '../model/equip-store.js'

function readOption(prefix) {
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))
}

async function parseOnly() {
  const inlineOption = readOption('--only=')
  const fileOption = readOption('--only-file=')
  const items = []

  if (inlineOption) {
    items.push(...inlineOption
      .slice('--only='.length)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean))
  }

  if (fileOption) {
    const filePath = path.resolve(fileOption.slice('--only-file='.length))
    const raw = await fs.readFile(filePath, 'utf8')
    const parsed = filePath.endsWith('.json')
      ? JSON.parse(raw)
      : raw.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)

    if (Array.isArray(parsed)) {
      items.push(...parsed.map((item) => String(item).trim()).filter(Boolean))
    }
  }

  return Array.from(new Set(items))
}

function parseLimit() {
  const option = readOption('--limit=')
  if (!option) {
    return Number.POSITIVE_INFINITY
  }

  const value = Number(option.slice('--limit='.length))
  return Number.isFinite(value) && value > 0 ? value : Number.POSITIVE_INFINITY
}

function parseDelayMs() {
  const option = readOption('--delay-ms=')
  if (!option) {
    return 5000
  }

  const value = Number(option.slice('--delay-ms='.length))
  return Number.isFinite(value) && value >= 0 ? value : 5000
}

function parseRetries() {
  const option = readOption('--retries=')
  if (!option) {
    return 4
  }

  const value = Number(option.slice('--retries='.length))
  return Number.isFinite(value) && value > 0 ? value : 4
}

function parseRetryDelayMs() {
  const option = readOption('--retry-delay-ms=')
  if (!option) {
    return 2500
  }

  const value = Number(option.slice('--retry-delay-ms='.length))
  return Number.isFinite(value) && value >= 0 ? value : 2500
}

async function equipDataExists(fullName) {
  try {
    await fs.access(getEquipDataFile(fullName))
    return true
  } catch {
    return false
  }
}

function filterIndexEntries(index, onlyList) {
  if (!onlyList.length) {
    return index
  }

  const querySet = new Set(onlyList)
  return index.filter((item) => {
    return querySet.has(item.full_name) || querySet.has(item.name) || querySet.has(item.wiki_url)
  })
}

function chunk(values, size) {
  const output = []
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size))
  }
  return output
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function localizeEquipImages(parsed) {
  if (parsed.image) {
    parsed.remote_image = parsed.image
    parsed.image = await downloadEquipImage(parsed.full_name, parsed.full_name, parsed.remote_image, {
      force: true,
      retries: currentRuntime.retries,
      retryDelayMs: currentRuntime.retryDelayMs
    })
    parsed.local_image = parsed.image
  }

  for (const item of parsed.acquisition?.research_route_items ?? []) {
    if (item.type !== 'equip' || !item.image) {
      continue
    }
    item.remote_image = item.image
    item.image = item.full_name === parsed.full_name
      ? parsed.image
      : await resolveReferencedEquipImagePath(item.full_name, item.remote_image)
    item.local_image = item.image
  }

  for (const row of parsed.acquisition?.rows ?? []) {
    if (row.label !== '研发路线' || !row.html) {
      continue
    }

    let localizedHtml = row.html
    for (const item of parsed.acquisition.research_route_items ?? []) {
      if (item.type !== 'equip' || !item.image) {
        continue
      }
      if (item.remote_image) {
        localizedHtml = localizedHtml.replaceAll(item.remote_image, item.image)
      }
      if (item.original_image) {
        localizedHtml = localizedHtml.replaceAll(item.original_image, item.image)
      }
    }

    localizedHtml = localizedHtml
      .replace(/<a[^>]*>\s*▷查看消耗\s*<\/a>/g, '')
      .replace(/\s+srcset="[^"]*"/g, '')
    row.html = localizedHtml
  }

  await cleanupEquipImageDir(parsed.full_name, [parsed.image])
}

const currentRuntime = {
  retries: 4,
  retryDelayMs: 2500
}

async function buildSingleEquip(meta, { saveHtml = true }) {
  const { data: html } = await fetchWithRetry(meta.wiki_url, {
    retries: currentRuntime.retries,
    retryDelayMs: currentRuntime.retryDelayMs
  })
  const parsed = parseEquipHtml(html, {
    htmlPath: saveHtml ? path.relative(process.cwd(), await writeEquipHtmlCache(meta.full_name, html)).replace(/\\/g, '/') : '',
    basicMeta: meta
  })

  await localizeEquipImages(parsed)
  parsed.generated_at = new Date().toISOString()
  parsed.source.type = 'remote_html'

  await writeEquipData(parsed)
  return parsed
}

async function main() {
  const onlyList = await parseOnly()
  const force = process.argv.includes('--force')
  const noCacheHtml = process.argv.includes('--no-cache-html')
  const limit = parseLimit()
  const delayMs = parseDelayMs()
  currentRuntime.retries = parseRetries()
  currentRuntime.retryDelayMs = parseRetryDelayMs()

  await ensureEquipDirs()
  const buildState = await loadEquipBuildState()
  const equipIndex = filterIndexEntries(await loadEquipIndex(), onlyList)
  const pending = []
  const completedSet = new Set(buildState.completed ?? [])

  for (const item of equipIndex) {
    if (force || (!completedSet.has(item.full_name) && !await equipDataExists(item.full_name))) {
      pending.push(item)
      if (pending.length >= limit) {
        break
      }
    }
  }

  let finished = 0
  let failed = 0

  for (let index = 0; index < pending.length; index += 1) {
    const meta = pending[index]
    try {
      const parsed = await buildSingleEquip(meta, { saveHtml: !noCacheHtml })
      finished += 1
       completedSet.add(parsed.full_name)
       delete buildState.failed?.[parsed.full_name]
       buildState.completed = Array.from(completedSet)
       await writeEquipBuildState(buildState)
      console.info(`[build:equip] 完成 ${finished}/${pending.length}: ${parsed.full_name}`)
    } catch (error) {
      failed += 1
      buildState.failed ??= {}
      buildState.failed[meta.full_name] = String(error?.message ?? error)
      buildState.completed = Array.from(completedSet)
      await writeEquipBuildState(buildState)
      console.error('[build:equip] 抓取失败:', error)
    }

    if (index < pending.length - 1 && delayMs > 0) {
      console.info(`[build:equip] 等待 ${delayMs}ms 后继续抓取下一个页面...`)
      await sleep(delayMs)
    }
  }

  console.info(`[build:equip] 构建完成，成功 ${finished} 条，失败 ${failed} 条。`)
}

main().catch((error) => {
  console.error('[build:equip] 构建失败:', error)
  process.exitCode = 1
})
