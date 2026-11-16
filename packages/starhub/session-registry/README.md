# @deepseek-ai/dsh-starhub-session-registry

StarHub 本地包(联动契约 §2.1/§5,不在上游):订阅入站 notification
`starhub/registry.sync`(Rust 主进程在注册表每次变更时推送全量快照
`{ sessions: [{ assetId, sessionId, kind, attachedBy }] }`),维护
assetId → 活跃 session 的视图;每次快照整体替换,初始为空。

以服务 `starhub-session-registry` 暴露:`list()` 返回当前全部活跃 session,
`forAsset(assetId)` 返回单个资产的记录(无则 undefined)。依赖同组合的
`@deepseek-ai/dsh-sdk-jsonrpc-server` 提供的 `sdk-notifications` 服务
(StarHub 对 sdk/server 的本地补丁,契约 §0/§2.1);组合中缺失时加载即报错。

session 所有权不变式(方案 B):SSH/SFTP/DB session 只有 Rust/Go 一份实体,
本插件只是它的 dsh 侧只读投影,不建立、不销毁连接。

## Model Experience

### Session registry snapshot

#### What the model sees

本包不直接向模型注入任何文本;`list()` / `forAsset()` 的数据由 `@deepseek-ai/dsh-starhub-live-context` 在 `agent/pre-step` 渲染为「StarHub live context」插件消息的一部分,模型看到的是该插件的快照文本(`assetId`、`sessionId`、`kind`、`attachedBy` 的逐行清单)。

#### Token effect

注册表本身不产生 token;模型可见 token 全部来自 live-context 的渲染(受其 `maxEvents` / `maxSnapshotChars` 配置约束),本包只影响渲染内容的来源。

#### KV Cache effect

快照内容随每次 `starhub/registry.sync` 整体替换;live-context 只在不重复注入已见内容时保持前缀稳定(由其自身的变更抑制负责),本包不干预。

## Known Limitations and Deferred Work

- **只读投影,无写回**:本插件只消费快照,不提供 attach/detach/断开操作;
  写路径在 Rust 主进程(`ssh_attach` / `ssh_detach` 等 command)。
- **快照替换不是增量**:注册表每次变更都推全量,高频变更会反复重建视图;
  契约 §2.1 明确全量快照语义,增量推送留待事件风暴治理时再评估。
