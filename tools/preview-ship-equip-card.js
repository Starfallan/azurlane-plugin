#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import template from 'art-template'
import puppeteer from 'puppeteer'
import { findShipFromCache, getCharacterRoot, toShipDirName } from '../model/cache-store.js'
import { buildShipEquipCardViewModel } from '../model/ship-equip-card-data.js'
import { getShipEquipFile, readShipEquipData } from '../model/ship-store.js'

function readOption(prefix) {
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))
}

function hasFlag(flag) {
  return process.argv.includes(flag)
}

function parseKeyword() {
  return process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? '纳希莫夫海军上将'
}

function parseOutput(shipName) {
  const arg = readOption('--output=')
  if (arg) {
    return path.resolve(arg.slice('--output='.length))
  }

  return path.resolve('temp', 'preview', `${toShipDirName(shipName)}-equip.png`)
}

async function buildPreviewHtml(view) {
  const templateFile = path.resolve('resources', 'wiki', 'ship-equip-card.html')
  const defaultLayout = path.resolve('resources', 'common', 'layout', 'default.html')

  template.defaults.root = path.resolve('resources')
  template.defaults.extname = '.html'
  template.defaults.minimize = false
  template.defaults.cache = false

  return template(templateFile, {
    ...view,
    defaultLayout,
    _res_path: '../../resources/',
    sys: {
      scale: 'data-scale="1.0"',
      copyright: `AzurLane Wiki Cache · ${view.generated_at_display || view.cacheMeta?.generatedAt || 'local preview'}`
    }
  })
}

async function waitForImages(page) {
  await page.evaluate(async () => {
    const images = Array.from(document.images)
    await Promise.all(images.map((img) => {
      if (img.complete) {
        return Promise.resolve()
      }

      return new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true })
        img.addEventListener('error', resolve, { once: true })
      })
    }))
  })
}

async function ensureOutputDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
}

async function writePreviewHtml(shipName, html) {
  const htmlPath = path.resolve('temp', 'preview-html', `${toShipDirName(shipName)}-equip.html`)
  await fs.mkdir(path.dirname(htmlPath), { recursive: true })
  await fs.writeFile(htmlPath, html, 'utf8')
  return htmlPath
}

async function resolveLocalBrowserExecutable() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean)

  for (const candidate of candidates) {
    try {
      await fs.access(candidate)
      return candidate
    } catch {
      continue
    }
  }

  return null
}

async function main() {
  const keyword = parseKeyword()
  const htmlOnly = hasFlag('--html-only')
  const { ship, alternatives, cacheMeta } = await findShipFromCache(keyword)
  const equip = await readShipEquipData(ship.name)
  const view = buildShipEquipCardViewModel({ ship, equip, keyword, alternatives, cacheMeta })
  const html = await buildPreviewHtml(view)
  const output = parseOutput(ship.name)
  const htmlFile = await writePreviewHtml(ship.name, html)

  if (htmlOnly) {
    console.info(`[preview:equip] 临时HTML: ${htmlFile}`)
    console.info(`[preview:equip] 配装数据: ${getShipEquipFile(ship.name)}`)
    return
  }

  const executablePath = await resolveLocalBrowserExecutable()
  await ensureOutputDir(output)

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    ...(executablePath ? { executablePath } : {})
  })

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1800, height: 3200, deviceScaleFactor: 1.25 })
    await page.goto(pathToFileURL(htmlFile).href, { waitUntil: 'networkidle0' })
    await waitForImages(page)
    const container = await page.$('#container')
    if (!container) {
      throw new Error('未找到预览容器 #container')
    }

    await container.screenshot({ path: output })
    console.info(`[preview:equip] 预览图已生成: ${output}`)
    console.info(`[preview:equip] 临时HTML: ${htmlFile}`)
    console.info(`[preview:equip] 配装数据: ${getShipEquipFile(ship.name)}`)
    console.info(`[preview:equip] 数据目录: ${path.join(getCharacterRoot(), ship.cacheDirName || toShipDirName(ship.name))}`)
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error('[preview:equip] 生成失败:', error)
  process.exitCode = 1
})
