#!/usr/bin/env node
/**
 * 把 client-nav 的 tsc 产物打成 DSH 客户端半边 `lib/client.js`（P1 自建构建链）。
 *
 * 产物形状是宿主的客户端模块协议:整个包体是一段
 * `window.__ModuleLoader__.load({ id, factory })`,factory 返回模块命名空间。
 * 基线模块（react / ui-primitives / client-store）走 `require(...)` 由宿主的
 * module table 供给,其它第三方实现库内联进同一个文件。
 *
 * CSS 处理是这里唯一"有分量"的部分:
 * - `*.module.css` 用 esbuild 原生的 `local-css` loader 得到作用域化类名映射,
 *   同时把样式汇总成一份 CSS 文本;
 * - 汇总的 CSS 以 `<style data-dsh-css="<id>">` 的形式在 factory 里注入一次
 *   (重复加载时按 tagId 去重),因为宿主只加载 JS,不会另外取 CSS 文件;
 * - tsc 不拷贝 .css,导入路径里的 `lib/types/` 要映射回 `src/`,否则解析不到。
 *
 * 用法: node scripts/build-client-bundle.mjs
 */
import { build } from 'esbuild'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkgDir = join(repoRoot, 'packages', 'starhub', 'client-nav')
const pkgId = '@deepseek-ai/dsh-starhub-client-nav'
const entry = join(pkgDir, 'lib', 'types', 'client', 'index.js')
const outFile = join(pkgDir, 'lib', 'client.js')

/**
 * 宿主 module table 供给的基线模块。只列 client-nav 真正 import 的裸包:
 * 多列出会让本该内联的实现库在运行期解析失败。
 */
const BASELINE_EXTERNALS = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-primitives',
]

if (!existsSync(entry)) {
  console.error(`缺少 tsc 产物 ${relative(repoRoot, entry)};先跑 npm run build:lib:client(tsc 阶段)`)
  process.exit(1)
}

const tmp = await mkdtemp(join(tmpdir(), 'starhub-client-bundle-'))
try {
  // 第一趟:解析 CSS（tsc 的 .css 导入指回 src/,并让 esbuild 汇总样式）。
  await build({
    absWorkingDir: repoRoot,
    entryPoints: [entry],
    outfile: join(tmp, 'client.js'),
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    external: BASELINE_EXTERNALS,
    sourcemap: false,
    logLevel: 'warning',
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.module.css': 'local-css', '.css': 'css' },
    plugins: [
      {
        // tsc 只把 import 语句原样搬进 lib/types/,.css 文件仍留在 src/。
        name: 'dsh-css-to-src',
        setup(b) {
          b.onResolve({ filter: /\.css$/ }, (args) => {
            if (!args.path.startsWith('.')) return null
            const abs = resolve(args.resolveDir, args.path)
            const swapped = abs.replace(`${sep}lib${sep}types${sep}`, `${sep}src${sep}`)
            return existsSync(swapped) ? { path: swapped } : { path: abs }
          })
        },
      },
    ],
  })

  const cssPath = join(tmp, 'client.css')
  const cssText = existsSync(cssPath) ? await readFile(cssPath, 'utf8') : ''
  const body = await readFile(join(tmp, 'client.js'), 'utf8')

  const tagId = `${pkgId}/styles`
  const banner = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkgId)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
\t\tif (typeof document !== "undefined" && !document.querySelector('style[data-dsh-css="${tagId}"]')) {
\t\t\tvar styleTag = document.createElement("style");
\t\t\tstyleTag.setAttribute("data-dsh-css", "${tagId}");
\t\t\tstyleTag.textContent = ${JSON.stringify(cssText)};
\t\t\tdocument.head.appendChild(styleTag);
\t\t}
`
  const footer = `\n\t\treturn module.exports;
\t}
});\n`

  const withoutMapComment = body.replace(/\n\/\/# sourceMappingURL=.*\n?$/u, '\n')
  await writeFile(outFile, `${banner}${withoutMapComment}${footer}`, 'utf8')
  console.log(
    `client-nav 客户端半边 → ${relative(repoRoot, outFile)}（内联 CSS ${Math.round(cssText.length / 1024)} KB,基线外部化 ${BASELINE_EXTERNALS.length} 个）`,
  )

  // Host 半边:client-nav 的 node 入口是空 apply,原样出一份 ESM(裸包全外部化,
  // 由宿主安装树解析)。它的依赖是 lib/types 的 tsc 产物,所以只做一层收束。
  const hostEntry = join(pkgDir, 'lib', 'types', 'index.js')
  const hostOut = join(pkgDir, 'lib', 'index.js')
  await build({
    absWorkingDir: repoRoot,
    entryPoints: [hostEntry],
    outfile: hostOut,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    external: ['*'],
    logLevel: 'warning',
  })
  console.log(`client-nav 宿主半边 → ${relative(repoRoot, hostOut)}`)
} finally {
  await rm(tmp, { recursive: true, force: true })
}
