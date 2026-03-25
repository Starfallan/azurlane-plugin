#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { parseEquipHtml } from '../model/equip-parser.js'
import {
  cleanupEquipImageDir,
  downloadEquipImage,
  EQUIP_ROOT,
  loadEquipIndex,
  resolveReferencedEquipImagePath,
  writeEquipData
} from '../model/equip-store.js'

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

  return path.join(EQUIP_ROOT, '双联装138.6mm主炮Mle1934#T0.html')
}

function findBasicMeta(list, parsed) {
  return list.find((item) => item.full_name === parsed.full_name)
    ?? list.find((item) => item.wiki_url === parsed.wiki_url)
    ?? list.find((item) => item.name === parsed.name && item.tier === parsed.tier)
    ?? null
}

async function enrichEquipData(parsed) {
  if (parsed.image) {
    parsed.remote_image = parsed.image
    parsed.image = await downloadEquipImage(parsed.full_name, parsed.full_name, parsed.remote_image, {
      force: true
    })
    parsed.local_image = parsed.image
  }

  for (const item of parsed.acquisition?.research_route_items ?? []) {
    if (item.type !== 'equip') {
      continue
    }

    if (item.image) {
      item.remote_image = item.image
      item.image = item.full_name === parsed.full_name
        ? parsed.image
        : await resolveReferencedEquipImagePath(item.full_name, item.remote_image)
      item.local_image = item.image
    }
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
  parsed.generated_at = new Date().toISOString()
  return parsed
}

async function main() {
  const htmlPath = parseHtmlArg()
  const html = await fs.readFile(htmlPath, 'utf8')
  const basicIndex = await loadEquipIndex()

  const prelim = parseEquipHtml(html, { htmlPath: path.relative(process.cwd(), htmlPath).replace(/\\/g, '/') })
  const basicMeta = findBasicMeta(basicIndex, prelim)
  const parsed = basicMeta
    ? parseEquipHtml(html, {
        htmlPath: path.relative(process.cwd(), htmlPath).replace(/\\/g, '/'),
        basicMeta
      })
    : prelim

  await enrichEquipData(parsed)

  const outputPath = await writeEquipData(parsed)
  console.info(`[build:equip] 已生成: ${outputPath}`)
}

main().catch((error) => {
  console.error('[build:equip] 生成失败:', error)
  process.exitCode = 1
})
