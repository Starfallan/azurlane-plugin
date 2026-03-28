import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { buildShipDataByName } from './ship-cache-builder.js'
import { buildShipEquipByName } from './ship-equip-builder.js'

const execFileAsync = promisify(execFile)
const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

function trimBlock(value) {
  return String(value ?? '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()
}

async function runGit(args) {
  return execFileAsync('git', args, {
    cwd: PLUGIN_ROOT,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024
  })
}

export async function updatePluginFromGit() {
  const branch = trimBlock((await runGit(['branch', '--show-current'])).stdout) || 'main'
  const before = trimBlock((await runGit(['rev-parse', 'HEAD'])).stdout)
  const fetchResult = await runGit(['fetch', '--prune', 'origin'])
  const pullResult = await runGit(['pull', '--rebase', '--autostash', 'origin', branch])
  const after = trimBlock((await runGit(['rev-parse', 'HEAD'])).stdout)

  let log = ''
  if (before !== after) {
    log = trimBlock((await runGit(['log', '--oneline', '--decorate', `${before}..${after}`])).stdout)
  }

  return {
    branch,
    before,
    after,
    updated: before !== after,
    fetchOutput: trimBlock(`${fetchResult.stdout}\n${fetchResult.stderr}`),
    pullOutput: trimBlock(`${pullResult.stdout}\n${pullResult.stderr}`),
    log
  }
}

export function formatGitUpdateReply(result) {
  const lines = [
    `碧蓝航线插件更新完成`,
    `分支：${result.branch}`
  ]

  if (result.updated) {
    lines.push(`版本：${result.before.slice(0, 7)} -> ${result.after.slice(0, 7)}`)
  } else {
    lines.push(`版本：${result.after.slice(0, 7)}（已是最新）`)
  }

  if (result.log) {
    lines.push('更新日志：')
    lines.push(result.log)
  } else if (result.pullOutput) {
    lines.push('Git 输出：')
    lines.push(result.pullOutput)
  }

  return lines.join('\n')
}

export function formatGitUpdateError(error) {
  const stdout = trimBlock(error?.stdout)
  const stderr = trimBlock(error?.stderr)
  const lines = [
    '碧蓝航线插件更新失败',
    '检测到 git 拉取过程中出现错误或冲突，请手动处理。'
  ]

  if (stdout) {
    lines.push('stdout:')
    lines.push(stdout)
  }

  if (stderr) {
    lines.push('stderr:')
    lines.push(stderr)
  }

  if (!stdout && !stderr && error?.message) {
    lines.push(String(error.message))
  }

  return lines.join('\n')
}

export async function refreshShipBundleByName(shipName) {
  const ship = await buildShipDataByName(shipName)
  const equip = await buildShipEquipByName(ship.ship.original_name || shipName)

  return {
    ship,
    equip
  }
}

export function formatShipRefreshReply(result) {
  const shipName = result.ship?.ship?.original_name || result.equip?.equip?.original_name || '未知舰船'
  const lines = [
    `已更新 ${shipName} 数据`,
    `资料：${result.ship?.filePath || '未写入'}`,
    `配装：${result.equip?.filePath || '未写入'}`
  ]

  const shipUpdatedAt = result.ship?.ship?.cacheUpdatedAt
  const equipUpdatedAt = result.equip?.equip?.generated_at
  if (shipUpdatedAt) {
    lines.push(`资料更新时间：${shipUpdatedAt}`)
  }
  if (equipUpdatedAt) {
    lines.push(`配装更新时间：${equipUpdatedAt}`)
  }

  return lines.join('\n')
}
