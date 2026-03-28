#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import template from 'art-template'
import puppeteer from 'puppeteer'
import { findShipFromCache, getCharacterRoot, toShipDirName } from '../model/cache-store.js'
import { buildShipCardViewModel } from '../model/ship-card-data.js'

function readOption(prefix) {
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))
}

function parseMode() {
  const arg = readOption('--mode=')
  return arg ? arg.slice('--mode='.length) : 'ship'
}

function parseKeyword() {
  return process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? '企业'
}

function parseOutput(shipName, mode) {
  const arg = readOption('--output=')
  if (arg) {
    return path.resolve(arg.slice('--output='.length))
  }

  return path.resolve('temp', 'preview', `${toShipDirName(shipName)}-${mode}.png`)
}

async function buildPreviewHtml(view) {
  const templateFile = path.resolve('resources', 'wiki', 'ship-card.html')
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
      scale: 'style="transform:scale(1);transform-origin:0 0;"',
      copyright: `AzurLane Wiki Cache · ${view.cacheMeta?.generatedAt ?? 'local preview'}`
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

async function writePreviewHtml(shipName, mode, html) {
  const htmlPath = path.resolve('temp', 'preview-html', `${toShipDirName(shipName)}-${mode}.html`)
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
  const mode = parseMode()
  const { ship, alternatives, cacheMeta } = await findShipFromCache(keyword)
  const view = buildShipCardViewModel({ ship, alternatives, cacheMeta, mode, keyword })
  const html = await buildPreviewHtml(view)
  const output = parseOutput(ship.name, mode)
  const htmlFile = await writePreviewHtml(ship.name, mode, html)
  const executablePath = await resolveLocalBrowserExecutable()

  await ensureOutputDir(output)

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    ...(executablePath ? { executablePath } : {})
  })

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1600, height: 2600, deviceScaleFactor: 1.5 })
    await page.goto(pathToFileURL(htmlFile).href, { waitUntil: 'networkidle0' })
    await waitForImages(page)
    const container = await page.$('#container')
    if (!container) {
      throw new Error('未找到预览容器 #container')
    }
    await container.screenshot({ path: output })
    console.info(`[preview] 预览图已生成: ${output}`)
    console.info(`[preview] 临时HTML: ${htmlFile}`)
    console.info(`[preview] 数据目录: ${path.join(getCharacterRoot(), ship.cacheDirName || toShipDirName(ship.name))}`)
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error('[preview] 生成失败:', error)
  process.exitCode = 1
})
