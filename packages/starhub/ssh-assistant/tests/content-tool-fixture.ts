/**
 * 测试夹具:定义一个「把内容块数组当作 canonical JSON 值」的工具。
 *
 * 上游 0.2.1 把同名 helper 从 `@deepseek-ai/dsh-tools` 导出(`src/testing.ts`),
 * 0.2.2 起该文件不再随包发布;这里只用**公开面**(`defineTool` + 公开类型)重建
 * 一份,语义与上游一致:输出契约固定为 JSON 数组,`render` 直接把值当内容块用。
 * 产品代码不要这么写(产品工具必须声明自己的 DTO)。
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  defineTool,
  type DefineToolOptions,
  type InferArgs,
  type ParameterSchemaSpec,
  type ToolDefinition,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools'

const CONTENT_VALUE_SCHEMA = { type: 'array', items: { type: 'json' } } as const

/** 夹具选项:普通工具字段 + 产出内容块的 execute。 */
export type ContentToolFixtureOptions<S extends ParameterSchemaSpec> = Omit<
  DefineToolOptions<S, typeof CONTENT_VALUE_SCHEMA>,
  'output' | 'execute'
> & {
  execute(args: InferArgs<S>, exec: ToolRunContext): Promise<ContentBlock[]>
}

/**
 * Build a registry-ready fixture tool whose canonical value is its content blocks.
 * @param options - fixture fields plus a content-producing body.
 * @returns the tool definition for `ctx.tools.register`.
 */
export function defineContentToolFixture<const S extends ParameterSchemaSpec>(
  options: ContentToolFixtureOptions<S>,
): ToolDefinition {
  const execute = options.execute
  return defineTool({
    ...options,
    output: {
      schema: CONTENT_VALUE_SCHEMA,
      render: (_args, value) => value as unknown as ContentBlock[],
    },
    async execute(args, exec) {
      return await execute(args, exec) as unknown as JsonValue[]
    },
  })
}
