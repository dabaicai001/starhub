#!/usr/bin/env node
/**
 * 清理 StarHub 自有包的构建产物(替代 Tauri 时代的 clean-vendor-starhub.mjs)。
 *
 * 清三处:每个包的 `lib/`(tsc 的 lib/types + 客户端 bundle)、工作台 app 的
 * `dist/`、以及 tsc 的增量信息。`lib/` 与 `dist/` 都已在 .gitignore 里。
 */
import { readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..')

async function subdirs(dir) {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

const targets = []
for (const name of await subdirs(join(repoRoot, 'packages', 'starhub'))) {
  targets.push(join(repoRoot, 'packages', 'starhub', name, 'lib'))
}
for (const name of await subdirs(join(repoRoot, 'packages', 'shims'))) {
  targets.push(join(repoRoot, 'packages', 'shims', name, 'lib'))
}
for (const name of await subdirs(join(repoRoot, 'apps'))) {
  targets.push(join(repoRoot, 'apps', name, 'lib'), join(repoRoot, 'apps', name, 'dist'))
}

for (const target of targets) await rm(target, { recursive: true, force: true })
console.log(`清掉 ${targets.length} 个产物目录`)
