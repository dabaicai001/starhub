import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const require = createRequire(import.meta.url)
const appDir = dirname(fileURLToPath(import.meta.url))

/**
 * StarHub 工作台独立资产入口的 Vite 构建(P1 起不再依赖 vendor)。
 *
 * 这个 app 只在 dsh 的 origin 下有意义(`/starhub-react/` 路由由
 * starhub-host-static 提供),所以 `vite dev` / `vite preview` 直接拒绝。
 *
 * 解析策略:
 * - StarHub 自己的包(client-nav / client-runtime 垫片)按 **源码** 解析,Vite
 *   直接编 TS/TSX,样式走 Vite 管线;
 * - 官方 `@deepseek-ai/dsh-*` 包走 node_modules(包里自带 `lib/*.js` 与
 *   `lib/*.module.css`,Vite 能正常处理 CSS Modules);
 * - 唯一的例外是 `ui-theme` 的 `styles/*` 子路径:官方包的 exports 只公开
 *   `./brand-font.css` 与 `./src/*`,所以 `styles/` 前缀要 alias 到包内
 *   `src/styles/`,否则 `@import` 解析不到。
 */
const themeStyles = `${join(dirname(require.resolve('@deepseek-ai/dsh-client-ui-theme/package.json')), 'src', 'styles')}/`
const clientNavSrc = `${join(appDir, '..', '..', 'packages', 'starhub', 'client-nav', 'src')}/`

export default defineConfig({
  plugins: [
    {
      name: 'starhub-workbench-reject-standalone-serve',
      config(_config, env) {
        if (env.command === 'serve') {
          throw new Error('starhub-workbench is served by dsh via /starhub-react; run `vite build` instead of a dev/preview server')
        }
      },
    },
    react(),
  ],
  base: '/starhub-react/',
  // tsc 面用 target es2024(声明产物);Vite 5 自带的 esbuild 只认到 es2022,
  // 不覆写的话每个文件都会报 "Unrecognized target environment"。
  esbuild: { target: 'es2022' },
  build: {
    target: 'es2022',
    sourcemap: true,
    outDir: 'dist',
  },
  resolve: {
    alias: [
      { find: /^@deepseek-ai\/dsh-client-ui-theme\/styles\//, replacement: themeStyles },
      { find: /^@deepseek-ai\/dsh-starhub-client-nav\/src\//, replacement: clientNavSrc },
    ],
  },
})
