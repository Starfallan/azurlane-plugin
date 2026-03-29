import plugin from '../../../lib/plugins/plugin.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { renderEquipCard, renderShipCard, renderShipEquipCard } from '../components/render.js'
import { CacheLookupError, findShipFromCache, getCharacterRoot, toShipDirName } from '../model/cache-store.js'
import { EquipLookupError, findEquipFromCache } from '../model/equip-cache-store.js'
import { readShipEquipData } from '../model/ship-store.js'
import {
  formatGitUpdateError,
  formatGitUpdateReply,
  formatShipRefreshReply,
  refreshShipBundleByName,
  updatePluginFromGit
} from '../model/admin-service.js'
import {
  buildMissingDataMessage,
  buildRenderFailureMessage,
  parseWikiCommand
} from '../model/wiki-command.js'

const COMMAND_HEAD = '(?:(?:;|；)\\s*(?:碧蓝|碧蓝航线|blhx)?|(?:碧蓝航线|碧蓝))\\s*'
const MATCH_ALL_RULE = `^${COMMAND_HEAD}.*$`
const COMMAND_TAIL = '[.。!！~～…]*$'
const UPDATE_PLUGIN_RULE = new RegExp(`^${COMMAND_HEAD}插件更新${COMMAND_TAIL}`, 'i')
const UPDATE_SHIP_DATA_RULE = new RegExp(`^${COMMAND_HEAD}更新(.+?)数据${COMMAND_TAIL}`, 'i')
let initLogged = false

const MODE_ALIAS = {
  属性: 'attribute',
  装备: 'equip',
  配装: 'ship-equip',
  配装推荐: 'ship-equip',
  推荐配装: 'ship-equip',
  技能: 'skill',
  天赋: 'skill',
  资料: 'ship',
  图鉴: 'ship'
}

const ROUTE_STEP = {
  EQUIP_ATTRIBUTE: 'equip-attribute',
  SHIP_CARD: 'ship-card',
  SHIP_EQUIP: 'ship-equip'
}

function isUpdatePluginCommand(message) {
  return UPDATE_PLUGIN_RULE.test(String(message ?? '').trim())
}

function parseShipUpdateCommand(message) {
  const match = String(message ?? '').trim().match(/^(?:(?:;|；)\s*(?:碧蓝|碧蓝航线|blhx)?|(?:碧蓝航线|碧蓝))\s*更新(.+?)数据[.。~～…]*$/i)
  if (!match) {
    return ''
  }

  return String(match[1] ?? '').replace(/\s+/g, '').trim()
}

function parseEquipDirectCommand(message) {
  const raw = String(message ?? '').trim()
  if (!raw) {
    return null
  }

  const match = raw.match(/^(?:(?:;|；)\s*(?:碧蓝|碧蓝航线|blhx)?|(?:碧蓝航线|碧蓝))\s*(.+?)[.。~～…]*$/i)
  if (!match) {
    return null
  }

  const keyword = String(match[1] ?? '').replace(/\s+/g, '').trim()
  if (!keyword) {
    return null
  }

  return {
    command: raw,
    keyword,
    rawMode: '装备',
    mode: 'equip'
  }
}

function parseShipSkinCommand(message) {
  const raw = String(message ?? '').trim()
  if (!raw) {
    return null
  }

  const match = raw.match(/^(?:(?:;|；)\s*(?:碧蓝|碧蓝航线|blhx)?|(?:碧蓝航线|碧蓝))\s*(.+?)\s*皮肤\s*(\d+)[.。!！~～…]*$/i)
  if (!match) {
    return null
  }

  const keyword = String(match[1] ?? '').replace(/\s+/g, '').trim()
  const skinIndex = Number.parseInt(String(match[2] ?? ''), 10)
  if (!keyword || !Number.isFinite(skinIndex) || skinIndex < 1) {
    return null
  }

  return {
    command: raw,
    keyword,
    skinIndex
  }
}

function inferShipInternalName(ship) {
  const direct = String(ship?.matched_internal_name ?? '').trim()
  if (direct) {
    return direct
  }

  const imagePath = String(ship?.image ?? '').trim().replace(/\\/g, '/')
  const match = imagePath.match(/\/img\/([^/]+?)_group\.avif$/i)
  return match?.[1] ? String(match[1]) : ''
}

function buildShipSkinFileName(internalName, skinIndex) {
  if (skinIndex <= 1) {
    return `${internalName}_group.avif`
  }

  return `${internalName}_${skinIndex}_group.avif`
}

function parseIncomingCommand(message) {
  if (isUpdatePluginCommand(message)) {
    return { type: 'admin-update-plugin' }
  }

  const updateKeyword = parseShipUpdateCommand(message)
  if (updateKeyword) {
    return {
      type: 'admin-update-ship',
      keyword: updateKeyword
    }
  }

  const skinParsed = parseShipSkinCommand(message)
  if (skinParsed) {
    return {
      type: 'ship-skin',
      parsed: skinParsed
    }
  }

  const parsed = parseWikiCommand(message)
  if (parsed) {
    return {
      type: 'wiki',
      parsed,
      source: 'explicit'
    }
  }

  const directParsed = parseEquipDirectCommand(message)
  if (!directParsed) {
    return null
  }

  return {
    type: 'wiki',
    parsed: directParsed,
    source: 'direct'
  }
}

function buildRoutePlan(parsed, source) {
  if (source === 'direct') {
    return {
      steps: [ROUTE_STEP.EQUIP_ATTRIBUTE, ROUTE_STEP.SHIP_CARD],
      missMessage: `未找到“${parsed.keyword}”对应的装备或舰船。`
    }
  }

  const routeType = MODE_ALIAS[parsed.rawMode] || 'ship'
  if (routeType === 'attribute') {
    return {
      steps: [ROUTE_STEP.EQUIP_ATTRIBUTE, ROUTE_STEP.SHIP_CARD],
      missMessage: `未找到“${parsed.keyword}”对应的装备或舰船。`
    }
  }

  if (routeType === 'equip') {
    return {
      steps: [ROUTE_STEP.EQUIP_ATTRIBUTE, ROUTE_STEP.SHIP_EQUIP],
      missMessage: `未找到“${parsed.keyword}”对应的装备或舰船。`
    }
  }

  if (routeType === 'ship-equip') {
    return {
      steps: [ROUTE_STEP.SHIP_EQUIP],
      missMessage: `本地缓存里没有找到“${parsed.keyword}”，请先确认名称或重新构建缓存。`
    }
  }

  return {
    steps: [ROUTE_STEP.SHIP_CARD],
    missMessage: `本地缓存里没有找到“${parsed.keyword}”，请先确认名称或重新构建缓存。`
  }
}

function isReplyPayload(payload) {
  return payload !== null && payload !== undefined && payload !== false
}

export class AzurLaneWiki extends plugin {
  constructor() {
    super({
      name: 'azurlane-wiki-cache',
      dsc: '读取本地缓存的碧蓝航线 Wiki 舰船资料并渲染图片',
      event: 'message',
      priority: 5000,
      rule: [
        {
          reg: MATCH_ALL_RULE,
          fnc: 'dispatchMessage'
        }
      ]
    })

    if (!initLogged) {
      initLogged = true
      const message = '[azurlane-plugin] 碧蓝航线 Wiki 插件初始化成功，已启用命令：;xxx / 碧蓝xxx'
      globalThis.logger?.info?.(message)
      if (!globalThis.logger?.info) {
        console.info(message)
      }
    }
  }

  async checkAuth(e) {
    if (e?.isMaster) {
      return true
    }
    return false
  }

  async dispatchMessage(e) {
    e.original_msg = e.original_msg || e.msg
    const message = String(e.original_msg ?? '').trim()
    if (!message) {
      return false
    }

    const command = parseIncomingCommand(message)
    if (!command) {
      return false
    }

    let result = false

    if (command.type === 'admin-update-plugin') {
      result = await this.updatePlugin(e)
    } else if (command.type === 'admin-update-ship') {
      result = await this.updateShipData(e)
    } else if (command.type === 'ship-skin') {
      result = await this.dispatchShipSkinCommand(command.parsed)
    } else if (command.type === 'wiki') {
      result = await this.dispatchWikiCommand(e, command.parsed, command.source)
    }

    return this.replyWithResult(e, result)
  }

  async replyWithResult(e, payload) {
    if (payload === true || payload === false) {
      return payload
    }

    if (!isReplyPayload(payload)) {
      return false
    }

    try {
      await e.reply(payload)
      return true
    } catch (error) {
      globalThis.logger?.error?.('[azurlane-plugin] 发送回复失败', error)
      return false
    }
  }

  async dispatchWikiCommand(e, parsed, source = 'explicit') {
    e.azurlaneWiki = parsed

    const plan = buildRoutePlan(parsed, source)
    for (const step of plan.steps) {
      const attempt = await this.dispatchRouteStep(e, parsed, step)
      if (attempt.hit) {
        return attempt.payload
      }
      if (attempt.fatal) {
        return attempt.payload
      }
    }

    return plan.missMessage
  }

  async dispatchRouteStep(e, parsed, step) {
    if (step === ROUTE_STEP.EQUIP_ATTRIBUTE) {
      const payload = await this.dispatchEquipAttributeCommand(e, parsed)
      if (payload === null) {
        return { hit: false, fatal: false, payload: null }
      }

      return { hit: true, fatal: false, payload }
    }

    if (step === ROUTE_STEP.SHIP_CARD) {
      return this.dispatchShipCardCommand(e, parsed)
    }

    if (step === ROUTE_STEP.SHIP_EQUIP) {
      return this.dispatchShipEquipCommand(e, parsed)
    }

    return { hit: false, fatal: true, payload: '查询配置异常，请稍后重试。' }
  }

  async dispatchShipCardCommand(e, parsed) {
    try {
      const { ship, alternatives, cacheMeta } = await findShipFromCache(parsed.keyword)
      const mode = parsed.mode === 'skill' ? 'skill' : 'ship'
      const image = await this.renderWikiCard(e, {
        ship,
        mode,
        keyword: parsed.keyword,
        alternatives,
        cacheMeta
      })

      if (!image) {
        return { hit: true, fatal: false, payload: buildRenderFailureMessage(mode) }
      }

      return { hit: true, fatal: false, payload: image }
    } catch (error) {
      if (error instanceof CacheLookupError) {
        return { hit: false, fatal: false, payload: null }
      }

      if (error?.code === 'ENOENT') {
        return {
          hit: true,
          fatal: false,
          payload: buildMissingDataMessage('ship', parsed.keyword)
        }
      }

      globalThis.logger?.error?.('[azurlane-plugin] 查询舰船资料失败', error)
      return {
        hit: true,
        fatal: true,
        payload: '查询失败了，请检查本地缓存数据是否存在且格式正确。'
      }
    }
  }

  async dispatchShipEquipCommand(e, parsed) {
    try {
      const { ship, alternatives, cacheMeta } = await findShipFromCache(parsed.keyword)
      const image = await this.renderEquipCard(e, {
        ship,
        keyword: parsed.keyword,
        alternatives,
        cacheMeta
      })

      if (!image) {
        return { hit: true, fatal: false, payload: buildRenderFailureMessage('equip') }
      }

      return { hit: true, fatal: false, payload: image }
    } catch (error) {
      if (error instanceof CacheLookupError) {
        return { hit: false, fatal: false, payload: null }
      }

      if (error?.code === 'ENOENT') {
        return {
          hit: true,
          fatal: false,
          payload: buildMissingDataMessage('equip', parsed.keyword)
        }
      }

      globalThis.logger?.error?.('[azurlane-plugin] 查询舰船配装失败', error)
      return {
        hit: true,
        fatal: true,
        payload: '查询失败了，请检查本地缓存数据是否存在且格式正确。'
      }
    }
  }

  async dispatchEquipAttributeCommand(e, parsed) {
    try {
      const { equip, entry, alternatives } = await findEquipFromCache(parsed.keyword)
      const image = await renderEquipCard(e, {
        equip,
        entry,
        keyword: parsed.keyword,
        alternatives
      })

      if (!image) {
        return '装备属性图片渲染失败，请检查 Yunzai 的 Puppeteer 渲染器配置。'
      }

      return image
    } catch (error) {
      if (error instanceof EquipLookupError) {
        if (error.reason === 'not-found') {
          return null
        }
        return error.message
      }

      if (error?.code === 'ENOENT') {
        return `本地还没有这条装备的属性缓存，请先执行 \`pnpm run build:equip -- --only=${parsed.keyword}\`。`
      }

      globalThis.logger?.error?.('[azurlane-plugin] 查询装备属性失败', error)
      return '查询装备属性失败，请检查本地装备缓存是否存在且格式正确。'
    }
  }

  async dispatchShipSkinCommand(parsed) {
    let ship
    try {
      const hit = await findShipFromCache(parsed.keyword)
      ship = hit.ship
    } catch (error) {
      if (error instanceof CacheLookupError) {
        return error.message
      }

      globalThis.logger?.error?.('[azurlane-plugin] 查询舰船皮肤失败', error)
      return '查询皮肤失败了，请检查本地缓存数据是否存在且格式正确。'
    }

    const internalName = inferShipInternalName(ship)
    if (!internalName) {
      return `未找到“${ship.name}”对应的皮肤立绘。`
    }

    const fileName = buildShipSkinFileName(internalName, parsed.skinIndex)
    const skinFile = path.join(getCharacterRoot(), toShipDirName(ship.name), 'img', fileName)
    try {
      await fs.access(skinFile)
      return globalThis.segment?.image?.(pathToFileURL(skinFile).href) ?? pathToFileURL(skinFile).href
    } catch {
      return `未找到“${ship.name}”对应的皮肤立绘（皮肤${parsed.skinIndex}）。`
    }
  }

  async renderWikiCard(e, payload) {
    return renderShipCard(e, payload)
  }

  async renderEquipCard(e, payload) {
    const equip = await readShipEquipData(payload.ship.name)
    return renderShipEquipCard(e, { ...payload, equip })
  }

  async updatePlugin(e) {
    if (!await this.checkAuth(e)) {
      return '只有主人才能使用这个命令。'
    }

    try {
      const result = await updatePluginFromGit()
      return formatGitUpdateReply(result)
    } catch (error) {
      globalThis.logger?.error?.('[azurlane-plugin] 插件更新失败', error)
      return formatGitUpdateError(error)
    }
  }

  async updateShipData(e) {
    if (!await this.checkAuth(e)) {
      return '只有主人才能使用这个命令。'
    }

    const keyword = parseShipUpdateCommand(e.original_msg || e.msg)
    if (!keyword) {
      return '请输入要更新的舰船名称，例如：;更新卡辛数据'
    }

    try {
      const result = await refreshShipBundleByName(keyword)
      return formatShipRefreshReply(result)
    } catch (error) {
      globalThis.logger?.error?.('[azurlane-plugin] 更新舰船缓存失败', error)
      return `更新 ${keyword} 数据失败：${error?.message || error}`
    }
  }
}
