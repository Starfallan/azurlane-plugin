#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { parseShipEquipHtml } from '../model/ship-equip-parser.js'
import { loadShipInstallDict, writeShipEquipData } from '../model/ship-store.js'
import { readEquipData } from '../model/equip-store.js'

function readOption(prefix) {
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))
}

function parseHtmlArg() {
  const option = readOption('--html=')
  if (option) {
    return path.resolve(option.slice('--html='.length))
  }

  const positional = process.argv.slice(2).find((arg) => !arg.startsWith('--'))
  if (positional) {
    return path.resolve(positional)
  }

  return path.resolve('temp', '纳希莫夫海军上将.html')
}

function findShipMeta(entries, shipName) {
  return entries.find((entry) => entry.original_name === shipName) ?? null
}

async function enrichEquipRef(ref) {
  try {
    const equip = await readEquipData(ref.full_name)
    return {
      ...ref,
      local_image: equip.local_image || equip.image || ''
    }
  } catch {
    return ref
  }
}

async function enrichParsed(parsed, meta) {
  const mergedRows = []
  for (const row of parsed.general_recommendation?.rows ?? []) {
    const cells = []
    for (const cell of row.cells ?? []) {
      if (!cell) {
        cells.push(null)
        continue
      }
      const refs = []
      for (const ref of cell.equip_refs ?? []) {
        refs.push(await enrichEquipRef(ref))
      }
      cells.push({ ...cell, equip_refs: refs })
    }
    mergedRows.push({ ...row, cells })
  }

  return {
    ...parsed,
    ship_id: meta?.ship_id || '',
    ship_name: meta?.original_name || parsed.page_title,
    original_name: meta?.original_name || parsed.page_title,
    alias_name: meta?.alias_name || '',
    matched_internal_name: meta?.matched_internal_name || '',
    release_date: meta?.release_date || '',
    general_recommendation: {
      ...parsed.general_recommendation,
      rows: mergedRows
    },
    generated_at: new Date().toISOString()
  }
}

async function main() {
  const htmlPath = parseHtmlArg()
  const html = await fs.readFile(htmlPath, 'utf8')
  const parsed = parseShipEquipHtml(html, {
    pageUrl: '',
    sourceFile: path.relative(process.cwd(), htmlPath).replace(/\\/g, '/')
  })

  const entries = await loadShipInstallDict()
  const meta = findShipMeta(entries, parsed.page_title)
  const shipName = meta?.original_name || parsed.page_title
  const output = await enrichParsed(parsed, meta)
  const filePath = await writeShipEquipData(shipName, output)
  console.info(`[build:ship-equip] 已生成: ${filePath}`)
}

main().catch((error) => {
  console.error('[build:ship-equip] 生成失败:', error)
  process.exitCode = 1
})
