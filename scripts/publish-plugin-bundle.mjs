#!/usr/bin/env node
/**
 * 把组装好的 StarHub DSH bundle 发布到 npm 注册表,让 DSH 0.2.2+ 的
 * 「插件页 → Update / Versions」可用。
 *
 * 为什么必须走注册表:DSH 的 `plugin-manager` 只把**按本名、从注册表安装**的
 * 第三方 profile 依赖标成 `updatable`(`updateRefusal()`);本地目录、git、
 * tarball 安装都没有 Versions 区块。tarball 仍保留为离线兜底,但那条路没有
 * 原地更新。
 *
 * 前置:
 * - `dist-plugin/` 已由 `node scripts/build-plugin-bundle.mjs --pack` 组装;
 * - 发布身份已配置(npm 登录,或 CI 里 NODE_AUTH_TOKEN + registry)。
 *
 * 用法:
 *   node scripts/publish-plugin-bundle.mjs [--dir dist-plugin] [--registry <url>]
 *     [--tag latest] [--dry-run] [--force]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assessUpdateEligibility, publishabilityProblems } from './build-plugin-bundle.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 命令行参数。 */
function parseArgs(argv) {
  const values = { dir: join(repoRoot, 'dist-plugin'), registry: null, tag: 'latest', dryRun: false, force: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      const value = argv[index]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 需要一个值`)
      return value
    }
    switch (arg) {
      case '--dir': values.dir = resolve(next()); break
      case '--registry': values.registry = next(); break
      case '--tag': values.tag = next(); break
      case '--dry-run': values.dryRun = true; break
      case '--force': values.force = true; break
      case '--help': console.log(usage()); process.exit(0); break
      default: throw new Error(`未知参数 ${arg}`)
    }
  }
  return values
}

function usage() {
  return [
    'Usage: node scripts/publish-plugin-bundle.mjs [flags]',
    '',
    '  --dir <dir>        组装产物目录,缺省 dist-plugin。',
    '  --registry <url>   发布到的注册表,缺省 npm 自身配置(CI 里通常显式给)。',
    '  --tag <tag>        dist-tag,缺省 latest。',
    '  --dry-run          只打包含内容,不真正上传。',
    '  --force            版本已存在时仍然尝试发布(默认跳过)。',
    '',
  ].join('\n')
}

/** 跑一次 npm,返回退出码;输出直接透传。 */
function npm(args, cwd) {
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  return result.status ?? 1
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const manifestPath = join(options.dir, 'package.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`找不到 ${manifestPath}:先跑 node scripts/build-plugin-bundle.mjs --pack`)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const spec = `${manifest.name}@${manifest.version}`

  const publishProblems = publishabilityProblems(manifest, options.dir)
  if (publishProblems.length > 0) {
    throw new Error(`包不可发布:\n  - ${publishProblems.join('\n  - ')}`)
  }
  const eligibility = assessUpdateEligibility(manifest, spec)
  if (!eligibility.updatable) {
    throw new Error(`发布后 DSH 仍不会标记为可更新:${eligibility.reason}`)
  }

  // 同一版本的 tag 重跑(手动重发 plugin-bundle.yml)不应失败:已发布就跳过。
  if (!options.force && options.dryRun === false) {
    const registryArgs = options.registry === null ? [] : ['--registry', options.registry]
    const probe = spawnSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['view', spec, 'version', '--json', ...registryArgs],
      { cwd: options.dir, encoding: 'utf8', shell: process.platform === 'win32' },
    )
    if (probe.status === 0) {
      console.log(`[publish] ${spec} 已存在于注册表,跳过(要重发加 --force)`)
      return
    }
  }

  const args = ['publish', '--access', 'public', '--tag', options.tag]
  if (options.registry !== null) args.push('--registry', options.registry)
  if (options.dryRun) args.push('--dry-run')
  console.log(`[publish] ${spec}(${options.tag}${options.registry === null ? '' : `,${options.registry}`}${options.dryRun ? ',dry-run' : ''})`)
  const status = npm(args, options.dir)
  if (status !== 0) throw new Error(`npm publish 退出码 ${String(status)}`)

  if (options.dryRun) {
    console.log('[publish] dry-run 完成:包内容与清单校验通过,未上传')
    return
  }
  console.log('[publish] 完成。安装与更新:')
  console.log(`  安装  dsh 插件页 → 添加插件 → ${spec}`)
  console.log('  更新  DSH 0.2.2-rc.1+ 插件页 → StarHub → 版本 → Update')
  console.log(`  离线  https://github.com/dabaicai001/starhub/releases(仅安装,无原地更新)`)
}

try {
  main()
} catch (error) {
  console.error(`publish-plugin-bundle: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
