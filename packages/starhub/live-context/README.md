# @deepseek-ai/dsh-starhub-live-context

StarHub 本地包(联动契约 §2.2/§5,方案 M3,不在上游):`agent/pre-step` 插件,
把「当前在发生什么」注入每个 agent 请求——

1. **registry 快照**:`starhub-session-registry` 服务的 `list()`(契约 §2.1);
2. **相关资产最近事件**:`starhub-domain-events` 服务的
   `recent(assetId, maxEvents)`(每资产默认 10 条,契约 §1);
3. **活性快照 pull**:经 `sdk-transport` 反向 RPC `starhub/live.snapshot`
   (契约 §2.2,transfers + recentExecs + taskTrails,与 `packages/starhub/tools` 同款宿主桥
   调用写法)。

整段文本按 `maxSnapshotChars`(默认 4000)截断,从头保留(registry/事件在前,
快照尾部先被裁掉)。pull 失败(宿主报错/进程断开)降级为本地 registry+events,
不抛错、不打断 pre-step;本地服务缺失时逐段降级;`enabled: false` 时不注入。

注入格式与 `starhub-tool-context` 对齐:同一 plugin-source user message
(`form: 'snapshot'`,`sections` 携带包名与全文),追加在 pre-step 链的
`decision.messages` 之后。

## Config

| key | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 是否注入活体上下文 |
| `maxEvents` | `10` | 每个相关资产最多注入的事件条数 |
| `maxSnapshotChars` | `4000` | 整段注入文本的字符上限 |

非法值(非正非整数)`maxEvents` / `maxSnapshotChars` 在加载时 fail loud。

## Model Experience

### StarHub live context snapshot

#### What the model sees

每个请求前注入一段「StarHub live context:」文本:活跃 session 注册表(`assetId` / `sessionId` / `kind` / `attachedBy`)、相关资产最近事件的 `kind` / `summary`(AI 起源带 `(ai)` 标记),以及 pull 到的传输与最近 AI 执行摘要(含输出尾部);全文受 `maxSnapshotChars` 截断。

#### Token effect

每次注入最多约 `maxSnapshotChars` 字符(默认 4000)的新文本,进入该请求的消息历史并被计入后续轮次,直到其他包压缩;高频会话中这是可观的上下文成本,`maxEvents` / `maxSnapshotChars` 是部署侧调优旋钮,`enabled` 可整体关闭。

#### KV Cache effect

注入内容随宿主状态变化而变化,会破坏可复用请求前缀的稳定性;live-context 每次 pre-step 都重新组装,未做变更抑制(变更抑制留待后续增强)。

## Known Limitations and Deferred Work

- **每步都注入**:不做变更抑制/去重,高频变更的会话每轮都会重新注入(可能
  破坏 KV cache 前缀稳定性);按状态哈希抑制注入是明确的后续增强。
- **快照文本不含敏感值校验**:注入内容直接来自宿主事件/快照字段,敏感值
  脱敏由宿主侧(契约 §1 summary 规则、§8 约束)负责,dsh 侧不做二次清洗。
- **pull 不随 abort 取消**:`sdk-transport` 的 peer 接口不携带 AbortSignal,
  取消中的 pre-step 只能跳过发起 pull,已发起的 pull 会等宿主应答。
