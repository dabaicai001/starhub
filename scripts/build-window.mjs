/**
 * 构建 StarHub React 工作台独立资产入口,并把产物落到仓库根 `dist-starhub-react/`。
 *
 * 这个目录是两处消费方的默认值:`starhub-host-static` 的 `/starhub-react` 前缀
 * 路由,以及 provisioning 拷进 `<dsh-home>/starhub/resources/` 的那份。
 *
 * P1 起 app 在 StarHub 自有的 workspace 里(`apps/starhub-workbench`,包名
 * `@starhub/workbench`),不再经 vendor 的 pnpm workspace 过滤构建。
 *
 * 用 Vite 的 Node API 而不是 `pnpm --filter <app> build`:pnpm 的提升安装会给每个
 * 包建 `.bin`,但包的 `node_modules/<tool>` 只是链接,`node_modules/.bin/vite`
 * 在 Windows 上会指到不存在的 `bin/vite.js`。走 API 就不依赖 bin 布局。
 *
 * 用法:node scripts/build-window.mjs
 * 环境变量:STARHUB_WINDOW_DIST —— 额外同步一份到该目录(部署在别处时用)。
 */
import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appDir = join(repoRoot, 'apps', 'starhub-workbench')
const appDist = join(appDir, 'dist')
const target = join(repoRoot, 'dist-starhub-react')
const runtimeTarget = process.env.STARHUB_WINDOW_DIST

await build({ root: appDir })

// 先清再拷:vite 的 outDir 每次干净,但这两个落地目录不会——不清就会一代代
// 累积带 hash 的 assets 与 sourcemap(v0.129.0 实测 staging 涨到 443 MB / 486 个文件,
// 而单次产物只有 21 MB),provisioning 会把这个目录整个拷进安装包。
await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
await cp(appDist, target, { recursive: true })
console.log(`starhub-workbench staged at ${target}`)

if (runtimeTarget !== undefined && runtimeTarget !== '' && resolve(runtimeTarget) !== target) {
  await rm(runtimeTarget, { recursive: true, force: true })
  await mkdir(runtimeTarget, { recursive: true })
  await cp(appDist, runtimeTarget, { recursive: true })
  console.log(`starhub-workbench synced to runtime at ${runtimeTarget}`)
}
