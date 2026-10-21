//! SSH/SFTP 域运行时:sidecar 侧的装配点(M1 第 4/5 步)。
//!
//! 执行体(会话生命周期 / 工具体 / 结果文本)已收敛到
//! [`starhub_domain_ssh::tools`]——Tauri 壳与 sidecar 共用同一份代码,
//! 差别只在注入:
//!
//! | 注入点 | sidecar | Tauri 壳 |
//! |---|---|---|
//! | [`AssetSource`] | `AssetStore`(assets.json + 密钥存储) | SQLite + Keyring |
//! | [`ExecTracker`] | 自有 map(`starhub/exec.abort` 中断) | 桥的 `inflight_tools`(`drain()` 中断) |
//! | [`EventSink`] | JSON-RPC 通知出口 | `tauri::Emitter` |
//!
//! 本模块只做装配 + 会话绑定 / 注册表这两个 sidecar 专属状态。

use std::collections::HashMap;
use std::sync::Arc;

use starhub_domain_ssh::events::{EventSink, KnownHostsStore, StoreFuture};
use starhub_domain_ssh::manager::SshManager;
use starhub_domain_ssh::sftp::transfer::TransferManager;
use starhub_domain_ssh::tools::{AssetSource, ExecTracker};

use crate::assets::AssetStore;
use crate::known_hosts_store::FileKnownHostsStore;

/// sidecar 的资产存储实现 [`AssetSource`](starhub_domain_ssh::tools::AssetSource)。
impl AssetSource for AssetStore {
    fn asset_ssh_config<'a>(
        &'a self,
        asset_id: &'a str,
    ) -> StoreFuture<'a, Result<(String, starhub_domain_ssh::SshConfig), String>> {
        let outcome = self.asset_ssh_config(asset_id);
        Box::pin(async move { outcome })
    }
}

/// sidecar 的域运行时(全部 `ssh_*` / `sftp_*` 方法共享的可变状态)。
pub struct SshRuntime {
    manager: SshManager,
    transfers: TransferManager,
    assets: Arc<AssetStore>,
    sink: Arc<dyn EventSink>,
    bindings: Arc<crate::bindings::SessionBindings>,
    registry: crate::session_registry::SessionRegistry,
    /// 在途 exec 的 exec_id → conn_id(停止生成时按 exec_id 中断)。
    ///
    /// std 锁:register/unregister 在 async 执行体里被调用,持锁期间不 await。
    inflight: std::sync::Mutex<HashMap<String, String>>,
}

impl SshRuntime {
    /// 装配运行时;`sink` 接收域事件(JSON-RPC 通知出口)。
    ///
    /// `bindings` 与 DB 域运行时共享:同一份「会话 → 资产」绑定对两个域可见。
    pub fn new(
        assets: Arc<AssetStore>,
        sink: Arc<dyn EventSink>,
        known_hosts: Arc<dyn KnownHostsStore>,
        bindings: Arc<crate::bindings::SessionBindings>,
    ) -> Self {
        Self {
            manager: SshManager::new(known_hosts),
            transfers: TransferManager::new(Arc::clone(&sink)),
            assets,
            sink,
            bindings,
            registry: crate::session_registry::SessionRegistry::new(),
            inflight: std::sync::Mutex::new(HashMap::new()),
        }
    }

    /// 用默认文件存储装配(资产/密钥/known_hosts 路径均走环境变量)。
    pub fn from_env(
        sink: Arc<dyn EventSink>,
        bindings: Arc<crate::bindings::SessionBindings>,
    ) -> anyhow::Result<Self> {
        let assets = Arc::new(AssetStore::from_env().map_err(|error| anyhow::anyhow!(error))?);
        let known_hosts: Arc<dyn KnownHostsStore> = Arc::new(FileKnownHostsStore::from_env());
        Ok(Self::new(assets, sink, known_hosts, bindings))
    }

    /// SSH 会话管理器(UI 面 `ui.ssh_*` / `ui.sftp_*` 的会话实体入口)。
    pub fn manager(&self) -> &SshManager {
        &self.manager
    }

    /// 资产存储(全局方法 `starhub_list_assets` 用)。
    pub fn assets(&self) -> &Arc<AssetStore> {
        &self.assets
    }

    /// 记录 会话→资产 绑定(`bind_asset_context`)。
    /// `terminal_session_id` 为该会话所在终端页的 SSH 会话 id(可选):
    /// SSH 页面里的 AI 助手据此复用**那个页面**的连接(v0.140.1)。
    pub fn bind_session(
        &self,
        session_id: &str,
        asset_type: &str,
        asset_id: &str,
        terminal_session_id: Option<&str>,
    ) {
        self.bindings
            .bind(session_id, asset_type, asset_id, terminal_session_id);
    }

    /// 记录 subagent 子→父会话映射(子代理继承父会话绑定)。
    pub fn record_subagent_parent(&self, child_session_id: &str, parent_session_id: &str) {
        self.bindings
            .record_subagent_parent(child_session_id, parent_session_id);
    }

    /// 沿父链解析会话绑定(方法面在参数缺 assetId 时用)。
    pub fn resolve_bound_asset(&self, session_id: &str) -> Option<crate::bindings::SessionBinding> {
        self.bindings.resolve(session_id)
    }

    /// 会话 → 资产绑定表(与 DB 域运行时共享)。
    pub fn bindings(&self) -> &Arc<crate::bindings::SessionBindings> {
        &self.bindings
    }

    /// 会话注册表(`starhub/registry.sync` 快照源)。
    pub fn registry(&self) -> &crate::session_registry::SessionRegistry {
        &self.registry
    }

    /// 传输任务表(`starhub/live.snapshot` 的 transfers 源)。
    pub fn transfers(&self) -> &TransferManager {
        &self.transfers
    }

    /// 事件出口(领域事件 / 注册表快照 / UI 动作意图通知)。
    pub fn sink(&self) -> &Arc<dyn EventSink> {
        &self.sink
    }

    /// 存活的 SSH 会话 id 集合(注册表快照的剔除依据)。
    pub async fn live_session_ids(&self) -> std::collections::HashSet<String> {
        self.manager.sessions.lock().await.keys().cloned().collect()
    }

    /// 装配执行上下文(资产 / 事件 / 在途登记三个注入点)。
    fn context(&self) -> starhub_domain_ssh::tools::ToolContext<'_> {
        starhub_domain_ssh::tools::ToolContext {
            manager: &self.manager,
            transfers: &self.transfers,
            assets: self.assets.as_ref(),
            sink: &self.sink,
            tracker: self,
        }
    }

    /// 执行 ssh_exec / ssh_exec_background / ssh_wait_task。
    ///
    /// 命令在用户终端已连接的会话上执行:`terminal_session`(调用方绑定携带的
    /// 终端页会话 id)优先——SSH 页面里的 AI 复用那个页面的连接;无页面上下文
    /// 时按资产取第一个存活者。未连接时返回引导文案,AI 不擅自建连
    /// (v0.140.0 新模型,v0.140.1 加页面级复用)。
    pub async fn execute_ssh(
        &self,
        name: &str,
        asset_id: &str,
        terminal_session: Option<&str>,
        args: &serde_json::Value,
    ) -> Result<String, String> {
        starhub_domain_ssh::tools::execute_ssh(
            &self.context(),
            name,
            asset_id,
            terminal_session,
            args,
        )
        .await
    }

    /// 查询当前绑定资产 SSH 会话状态(不触发连接)。
    pub async fn execute_ssh_status(
        &self,
        asset_id: &str,
        terminal_session: Option<&str>,
    ) -> Result<String, String> {
        starhub_domain_ssh::tools::execute_ssh_status(
            &self.context(),
            asset_id,
            terminal_session,
        )
        .await
    }

    /// 执行 sftp_list / sftp_stat / sftp_upload / sftp_download。
    pub async fn execute_sftp(
        &self,
        name: &str,
        asset_id: &str,
        terminal_session: Option<&str>,
        args: &serde_json::Value,
    ) -> Result<String, String> {
        starhub_domain_ssh::tools::execute_sftp(
            &self.context(),
            name,
            asset_id,
            terminal_session,
            args,
        )
        .await
    }

    /// 中断一条在途 exec(停止生成);exec_id 未知(已结束)按未中断返回。
    pub async fn abort_exec(&self, exec_id: &str) -> Result<bool, String> {
        let conn_id = self
            .inflight
            .lock()
            .unwrap()
            .get(exec_id)
            .cloned()
            .ok_or_else(|| format!("未知或已结束的 exec_id: {exec_id}"))?;
        self.inflight.lock().unwrap().remove(exec_id);
        starhub_domain_ssh::manager::ssh_exec_abort_core(&self.manager, &conn_id, exec_id).await
    }
}

/// sidecar 的在途 exec 登记:exec_id → conn_id(`starhub/exec.abort` 据此中断)。
///
/// 用 `std::sync::Mutex` 而非 tokio 的:register/unregister 在 async 执行体里
/// 被调用且操作瞬时完成,持锁期间不 await——std 锁既不会阻塞运行时,也不会
/// 像 `blocking_lock` 那样在 tokio 上下文里直接 panic。
impl ExecTracker for SshRuntime {
    fn register(&self, exec_id: &str, conn_id: &str) {
        self.inflight
            .lock()
            .unwrap()
            .insert(exec_id.to_string(), conn_id.to_string());
    }

    fn unregister(&self, exec_id: &str) {
        self.inflight.lock().unwrap().remove(exec_id);
    }
}

/// 解析目标资产:显式 `assetId` 优先,否则用会话绑定(沿 subagent 父链)。
///
/// SSH 与 DB 两个域的方法面共用(bridge 的 `starhub/tool.execute` 兼容层
/// 最终也走到这里);无绑定时的引导文案与 Tauri 版 `execute_domain_tool` 一致。
pub fn resolve_asset_id(
    bindings: &crate::bindings::SessionBindings,
    params: &serde_json::Value,
) -> Result<String, String> {
    if let Some(asset_id) = params
        .get("assetId")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok(asset_id.to_string());
    }
    if let Some(session_id) = params
        .get("sessionId")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if let Some(binding) = bindings.resolve(session_id) {
            return Ok(binding.asset_id);
        }
    }
    Err(
        "缺少 assetId,且当前会话未绑定资产:请先调用 starhub_list_assets 查看可用资产,\
         再调用 bind_asset_context 绑定目标资产(不打开窗口),或调用 open_connection / \
         focus_terminal 打开目标资产后重试"
            .to_string(),
    )
}

/// 解析发起调用的会话绑定的**终端页会话 id**(v0.140.1)。
///
/// SSH 终端页里的 AI 助手在 `bind_asset_context` 时带上所在页面的会话 id,
/// 域工具据此优先复用那个页面的连接;主壳 AI 等无页面上下文的调用返回 None
/// (回落按资产取第一个存活会话)。
pub fn resolve_terminal_session(
    bindings: &crate::bindings::SessionBindings,
    params: &serde_json::Value,
) -> Option<String> {
    let session_id = params
        .get("sessionId")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    bindings.resolve_terminal_session(session_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use starhub_domain_ssh::events::{EventSink, MemoryKnownHostsStore};

    struct NoopSink;

    impl EventSink for NoopSink {
        fn emit(&self, _event: &str, _payload: serde_json::Value) {}
    }

    /// 空资产库 + 内存密钥的运行时(不触网)。
    fn runtime_in_temp(label: &str) -> (Arc<SshRuntime>, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("starhub-runtime-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let assets = Arc::new(AssetStore::new(
            dir.join("assets.json"),
            Box::new(crate::assets::MemorySecretStore::new()),
        ));
        let runtime = Arc::new(SshRuntime::new(
            Arc::clone(&assets),
            Arc::new(NoopSink),
            Arc::new(MemoryKnownHostsStore::default()),
            Arc::new(crate::bindings::SessionBindings::new()),
        ));
        (runtime, dir)
    }

    // ---------- 运行时:空资产库上的软错误(不触网) ----------

    #[tokio::test]
    async fn ssh_tools_report_missing_asset_without_touching_the_network() {
        let (runtime, dir) = runtime_in_temp("empty");
        // 未知资产:resolve_user_session 在解析资产配置处失败,文案与 Tauri 版一致
        let err = runtime
            .execute_ssh("ssh_exec", "ghost", None, &serde_json::json!({ "command": "ls" }))
            .await
            .unwrap_err();
        assert_eq!(err, "资产不存在: ghost");
        // 状态查询同样不肯为未知资产编造会话状态
        let err = runtime.execute_ssh_status("ghost", None).await.unwrap_err();
        assert_eq!(err, "资产不存在: ghost");

        // 空资产库的清单
        assert_eq!(runtime.assets().list_assets_text(None).unwrap(), "[]");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn ssh_tools_ask_the_user_to_connect_instead_of_connecting() {
        // 新模型(v0.140.0):资产存在但用户终端未连接——AI 不得自建连接,
        // 返回引导文案,由模型提示用户去连接。terminal_session 给不给都一样:
        // 没有活会话可复用。
        let (runtime, dir) = runtime_in_temp("unconnected");
        runtime
            .assets()
            .upsert(
                "a1",
                "ssh",
                "验收机",
                serde_json::json!({ "host": "10.0.0.1", "port": 22, "username": "root", "password": "pw" }),
                None,
                vec![],
                false,
            )
            .expect("建资产");
        let hint = runtime
            .execute_ssh(
                "ssh_exec",
                "a1",
                Some("a1__k3f9a2"),
                &serde_json::json!({ "command": "ls" }),
            )
            .await
            .expect("未连接是软引导,不是错误");
        assert!(hint.contains("尚未连接"), "{hint}");
        assert!(hint.contains("复用你的连接"), "{hint}");
        let status = runtime.execute_ssh_status("a1", None).await.unwrap();
        assert!(status.contains("SSH 终端尚未连接(资产 a1)"), "{status}");
        let sftp = runtime
            .execute_sftp("sftp_list", "a1", None, &serde_json::json!({ "path": "/tmp" }))
            .await
            .expect("未连接是软引导,不是错误");
        assert!(sftp.contains("尚未连接"), "{sftp}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---------- 资产解析:显式 assetId / 会话绑定 / 父链 ----------

    #[tokio::test]
    async fn resolve_asset_id_prefers_the_explicit_parameter() {
        let bindings = crate::bindings::SessionBindings::new();
        bindings.bind("session-1", "ssh", "from-binding", None);
        let params = serde_json::json!({ "assetId": "explicit", "sessionId": "session-1" });
        assert_eq!(resolve_asset_id(&bindings, &params).unwrap(), "explicit");
    }

    #[tokio::test]
    async fn resolve_asset_id_falls_back_to_the_session_binding() {
        let bindings = crate::bindings::SessionBindings::new();
        bindings.bind("root", "ssh", "root-asset", None);
        bindings.record_subagent_parent("child", "root");
        let params = serde_json::json!({ "sessionId": "child" });
        assert_eq!(resolve_asset_id(&bindings, &params).unwrap(), "root-asset");
    }

    #[test]
    fn resolve_terminal_session_rides_the_binding_chain() {
        // v0.140.1:SSH 页面里的 AI 助手绑定携带所在页面的会话 id;域工具据此
        // 优先复用那个页面的连接。无页面上下文(主壳 AI)时为 None。
        let bindings = crate::bindings::SessionBindings::new();
        bindings.bind("root", "ssh", "root-asset", Some("root-asset__k3f9a2"));
        bindings.record_subagent_parent("child", "root");
        let with_page = serde_json::json!({ "sessionId": "child" });
        assert_eq!(
            resolve_terminal_session(&bindings, &with_page).as_deref(),
            Some("root-asset__k3f9a2")
        );
        // 没带页面 id 的绑定 / 无 sessionId 参数:None
        bindings.bind("plain", "ssh", "root-asset", None);
        assert_eq!(
            resolve_terminal_session(&bindings, &serde_json::json!({ "sessionId": "plain" })),
            None
        );
        assert_eq!(
            resolve_terminal_session(&bindings, &serde_json::json!({})),
            None
        );
    }

    #[test]
    fn resolve_asset_id_without_any_source_guides_the_model() {
        let bindings = crate::bindings::SessionBindings::new();
        let error = resolve_asset_id(&bindings, &serde_json::json!({})).unwrap_err();
        assert!(error.contains("bind_asset_context"), "{error}");
        assert!(error.contains("starhub_list_assets"), "{error}");
    }

    // ---------- 在途 exec 登记(ExecTracker seam) ----------

    #[tokio::test]
    async fn exec_tracker_registers_and_aborts_by_exec_id() {
        let (runtime, dir) = runtime_in_temp("tracker");
        // ExecTracker seam:登记 → abort 能定位到 conn_id(会话不存在 → 硬错误,
        // 但登记已清掉;再 abort 即「未知 exec_id」)
        <SshRuntime as ExecTracker>::register(&runtime, "exec-1", "dsh:asset-1:ssh");
        let err = runtime.abort_exec("exec-1").await.unwrap_err();
        assert!(err.contains("SSH session"), "{err}");
        let err = runtime.abort_exec("exec-1").await.unwrap_err();
        assert!(err.contains("未知或已结束"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
