# @deepseek-ai/dsh-starhub-domain-events

StarHub 本地包(联动契约 §1/§2.1/§5,不在上游):订阅入站 notification
`starhub/domain.event`(事件产生即报,schema 见契约 §1:
`{ kind, assetId?, ts, summary, data?, origin? }`),按资产维护环形缓冲
(每资产最近 50 条;无 assetId 的事件进全局桶),供 pre-step 注入与查询。

以服务 `starhub-domain-events` 暴露:`recent(assetId?, limit?)` 按 ts 倒序
返回事件(默认 limit 10;assetId 省略时合并全局桶与所有资产桶)。依赖同组合
的 `@deepseek-ai/dsh-sdk-jsonrpc-server` 提供的 `sdk-notifications` 服务
(StarHub 对 sdk/server 的本地补丁,契约 §0/§2.1);组合中缺失时加载即报错。

线边界校验(契约 §1):kind/ts/summary 缺失的帧丢弃;assetId 存在但非法的帧
丢弃;origin 省略规范化为 `user`。事件仅驻留内存,不落 session log(沉淀由
宿主侧 session log 通道负责,见设计文档 M2)。

## Model Experience

### Domain event summaries

#### What the model sees

本包不直接向模型注入任何文本;`recent()` 返回的事件由 `@deepseek-ai/dsh-starhub-live-context` 在 `agent/pre-step` 渲染为「StarHub live context」插件消息的一部分,模型看到的是 `kind`、`ts`、`summary`、`origin`(及可选 `assetId`)的逐行摘要。

#### Token effect

缓冲本身不产生 token;模型可见 token 全部来自 live-context 的渲染(受其 `maxEvents` / `maxSnapshotChars` 配置约束),本包只影响渲染内容的来源。

#### KV Cache effect

事件追加只改变 `recent()` 的结果;live-context 只在不重复注入已见内容时保持前缀稳定(由其自身的变更抑制负责),本包不干预。

## Known Limitations and Deferred Work

- **内存缓冲,不持久化**:事件只保留在进程内环形缓冲,重启即失;历史沉淀走
  dsh session log(宿主侧),本包不承担。
- **非幂等事件流**:同一事件可能被宿主重复推送,缓冲不去重;需要精确一次的
  消费语义时由消费者按 (assetId, kind, ts) 自行去重。
