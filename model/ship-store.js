import fs from 'node:fs/promises'
import path from 'node:path'
import { getCharacterRoot, toShipDirName } from './cache-store.js'

export const CHARACTER_ROOT = getCharacterRoot()
export const SHIP_DICT_FILE = path.resolve('resources', 'ship_dict_from_install_dates.json')
export const SHIP_BUILD_STATE_FILE = path.join(CHARACTER_ROOT, 'build-state.json')
export const SHIP_EQUIP_BUILD_STATE_FILE = path.join(CHARACTER_ROOT, 'equip-build-state.json')

export async function ensureCharacterDirs() {
  await fs.mkdir(CHARACTER_ROOT, { recursive: true })
}

export async function loadShipInstallDict() {
  const raw = await fs.readFile(SHIP_DICT_FILE, 'utf8')
  const parsed = JSON.parse(raw)
  return Array.isArray(parsed?.entries) ? parsed.entries : []
}

export function getShipDataDir(shipName) {
  return path.join(CHARACTER_ROOT, toShipDirName(shipName))
}

export function getShipDataFile(shipName) {
  return path.join(getShipDataDir(shipName), 'data.json')
}

export function getShipEquipFile(shipName) {
  return path.join(getShipDataDir(shipName), 'equip.json')
}

export function getExpectedShipLocalImagePath(shipName, internalName) {
  if (!internalName) {
    return ''
  }

  return path.relative(
    process.cwd(),
    path.join(getShipDataDir(shipName), 'img', `${internalName}_group.avif`)
  ).replace(/\\/g, '/')
}

export async function shipDataExists(shipName) {
  try {
    const raw = await fs.readFile(getShipDataFile(shipName), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed?.cacheVersion >= 2
      && typeof parsed?.matched_internal_name === 'string'
      && typeof parsed?.release_date === 'string'
      && typeof parsed?.wiki_image === 'string'
      && typeof parsed?.image === 'string'
  } catch {
    return false
  }
}

export async function readShipData(shipName) {
  const raw = await fs.readFile(getShipDataFile(shipName), 'utf8')
  return JSON.parse(raw)
}

export async function writeShipData(shipName, ship) {
  const dirPath = getShipDataDir(shipName)
  const filePath = path.join(dirPath, 'data.json')
  await fs.mkdir(dirPath, { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(ship, null, 2)}\n`, 'utf8')
  return filePath
}

export async function shipEquipExists(shipName) {
  try {
    const raw = await fs.readFile(getShipEquipFile(shipName), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed?.version >= 1 && parsed?.has_data === true
  } catch {
    return false
  }
}

export async function readShipEquipData(shipName) {
  const raw = await fs.readFile(getShipEquipFile(shipName), 'utf8')
  return JSON.parse(raw)
}

export async function writeShipEquipData(shipName, equip) {
  const dirPath = getShipDataDir(shipName)
  const filePath = path.join(dirPath, 'equip.json')
  await fs.mkdir(dirPath, { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(equip, null, 2)}\n`, 'utf8')
  return filePath
}

export async function loadShipBuildState() {
  try {
    const raw = await fs.readFile(SHIP_BUILD_STATE_FILE, 'utf8')
    return JSON.parse(raw)
  } catch {
    return {
      version: 1,
      completed: [],
      failed: {},
      updated_at: ''
    }
  }
}

export async function writeShipBuildState(state) {
  const payload = {
    version: 1,
    completed: Array.from(new Set(state.completed ?? [])),
    failed: state.failed ?? {},
    updated_at: new Date().toISOString()
  }

  await fs.mkdir(path.dirname(SHIP_BUILD_STATE_FILE), { recursive: true })
  await fs.writeFile(SHIP_BUILD_STATE_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return payload
}

export async function loadShipEquipBuildState() {
  try {
    const raw = await fs.readFile(SHIP_EQUIP_BUILD_STATE_FILE, 'utf8')
    return JSON.parse(raw)
  } catch {
    return {
      version: 1,
      completed: [],
      failed: {},
      updated_at: ''
    }
  }
}

export async function writeShipEquipBuildState(state) {
  const payload = {
    version: 1,
    completed: Array.from(new Set(state.completed ?? [])),
    failed: state.failed ?? {},
    updated_at: new Date().toISOString()
  }

  await fs.mkdir(path.dirname(SHIP_EQUIP_BUILD_STATE_FILE), { recursive: true })
  await fs.writeFile(SHIP_EQUIP_BUILD_STATE_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return payload
}
