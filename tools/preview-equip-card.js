#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import template from 'art-template'
import puppeteer from 'puppeteer'
import { buildEquipCardViewModel } from '../model/equip-card-data.js'
import { findEquipFromCache } from '../model/equip-cache-store.js'

function parseKeyword() {
  return process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? '试作舰载型La-9'
}

function readOption(prefix) {
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))
}

function parseOutput(fullName) {
  const arg = readOption('--output=')
  if (arg) {
    return path.resolve(arg.slice('--output='.length))
  }

  return path.resolve('temp', 'preview', `${fullName}-equip-attr.png`)
}

async function buildPreviewHtml(view) {
  const templateFile = path.resolve('resources', 'wiki', 'equip-card.html')
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
      copyright: `AzurLane Wiki Cache · ${view.generated_at_display || 'local preview'}`
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
  const { equip, entry, alternatives } = await findEquipFromCache(keyword)
  const view = buildEquipCardViewModel({ equip, entry, keyword, alternatives })
  const html = await buildPreviewHtml(view)

  const htmlFile = path.resolve('temp', 'preview-html', `${view.full_name}-equip-attr.html`)
  const output = parseOutput(view.full_name)

  await fs.mkdir(path.dirname(htmlFile), { recursive: true })
  await fs.writeFile(htmlFile, html, 'utf8')
  await fs.mkdir(path.dirname(output), { recursive: true })

  const executablePath = await resolveLocalBrowserExecutable()
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
    console.info(`[preview:equip-attr] 预览图已生成: ${output}`)
    console.info(`[preview:equip-attr] 临时HTML: ${htmlFile}`)
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error('[preview:equip-attr] 生成失败:', error)
  process.exitCode = 1
})
