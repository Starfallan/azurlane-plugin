#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { buildShipEquipCache } from '../model/ship-equip-builder.js'

function readOption(prefix) {
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))
}

async function parseOnlyNames() {
  const onlyArg = readOption('--only=')
  const onlyFileArg = readOption('--only-file=')
  const items = []

  if (onlyArg) {
    items.push(...onlyArg
      .slice('--only='.length)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean))
  }

  if (onlyFileArg) {
    const filePath = path.resolve(onlyFileArg.slice('--only-file='.length))
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
  const arg = readOption('--limit=')
  if (!arg) {
    return Number.POSITIVE_INFINITY
  }
  const value = Number(arg.slice('--limit='.length))
  return Number.isFinite(value) && value > 0 ? value : Number.POSITIVE_INFINITY
}

function parseDelayMs() {
  const arg = readOption('--delay-ms=')
  if (!arg) {
    return 5000
  }
  const value = Number(arg.slice('--delay-ms='.length))
  return Number.isFinite(value) && value >= 0 ? value : 5000
}

function parseRetries() {
  const arg = readOption('--retries=')
  if (!arg) {
    return 4
  }
  const value = Number(arg.slice('--retries='.length))
  return Number.isFinite(value) && value > 0 ? value : 4
}

function parseRetryDelayMs() {
  const arg = readOption('--retry-delay-ms=')
  if (!arg) {
    return 2500
  }
  const value = Number(arg.slice('--retry-delay-ms='.length))
  return Number.isFinite(value) && value >= 0 ? value : 2500
}

async function main() {
  const force = process.argv.includes('--force')
  const only = await parseOnlyNames()
  const limit = parseLimit()
  const delayMs = parseDelayMs()
  const retries = parseRetries()
  const retryDelayMs = parseRetryDelayMs()

  const result = await buildShipEquipCache({ force, only, limit, delayMs, retries, retryDelayMs })
  console.info(`[build:ship-equip] 已写入 ${result.count} 条舰船配装缓存，失败 ${result.failed ?? 0} 条。`)
}

main().catch((error) => {
  console.error('[build:ship-equip] 构建失败:', error)
  process.exitCode = 1
})
