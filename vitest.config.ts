import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { defineConfig } from 'vitest/config'

const require = createRequire(import.meta.url)
const rendererDir = dirname(require.resolve('@deepseek-ai/dsh-client-ui-renderer/package.json'))

/**
 * StarHub 自有单测(vitest)。P1 把各包的 `tests/` 随源码一起迁出了 vendor,
 * 这里把它们接回根 workspace 的测试入口。
 *
 * 约定与上游一致:
 * - 默认 node 环境;需要 DOM 的用例在文件首行写 `// @vitest-environment jsdom`
 *   (所以 `jsdom` 是根 devDependency)。
 * - 用例直接 `import '../src/xxx.ts'`,不依赖构建产物——测的是源码行为。
 * - 官方包的 **`/client` 条目是 loader 包装产物**(首行就调
 *   `window.__ModuleLoader__.load`),测试里必须解析到它的 `src/`;否则在 node
 *   环境里连导入都会炸。这也是上游「测试解析到源码」策略的原因。
 */
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@deepseek-ai\/dsh-client-ui-renderer\/client$/,
        replacement: join(rendererDir, 'src', 'client', 'index.ts'),
      },
    ],
  },
  esbuild: {
    // tsc 面用 react-jsx;esbuild 侧显式声明,避免 tsx 用例被当成 classic runtime。
    jsx: 'automatic',
    target: 'es2022',
  },
  test: {
    include: [
      'packages/starhub/*/tests/**/*.spec.ts',
      'packages/starhub/*/tests/**/*.spec.tsx',
      'apps/*/tests/**/*.spec.ts',
      'apps/*/tests/**/*.spec.tsx',
    ],
    environment: 'node',
    reporters: ['default'],
    // 每个包都是独立 workspace 包,用例之间不共享状态;并发跑以缩短反馈。
    fileParallelism: true,
    // 组合级用例(真起 HTTP 路由 + 跑完整 assistant 回合)在 Windows 开发机上
    // 常超过 vitest 默认的 5s;给测试与 hook 同一份预算,避免把"机器慢"误判成缺陷。
    testTimeout: 30_000,
    hookTimeout: 30_000,
    server: {
      deps: {
        // 官方客户端包的 lib/*.js 会 import 自己的 `.module.css`;不 inline 的话
        // Node 直接按 ESM 去加载 .css 会报 Unknown file extension,而 inline 后
        // 由 Vite 的 CSS 管线处理(样式内容对断言无意义,类名映射才有)。
        inline: [/@deepseek-ai\/dsh-client-/, /@deepseek-ai\/dsh-api-/],
      },
    },
  },
})
