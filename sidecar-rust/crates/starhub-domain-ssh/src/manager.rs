//! SSH 会话管理器与进程内执行核心(去 Tauri 化 M1 从 `src-tauri/src/commands/ssh.rs` 平移)。
//!
//! 这里只保留与宿主无关的部分:会话表 / 代次守卫 / 在途 exec 取消句柄 /
//! 建连与一次性 exec 通道。Tauri 专属的三件事留在 `src-tauri` 侧:
//! 1. [`crate::events::EventSink`] 的 Tauri 实现(`adapters::TauriEventSink`);
//! 2. [`crate::events::KnownHostsStore`] 的 SQLite 实现;
//! 3. `#[tauri::command]` 命令面(薄封装,转调本模块的 `*_core` 函数)。
//!
//! sidecar 侧以同一份代码建连/执行,只是注入自己的 sink 与存储实现。

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::events::{EventSink, EventSinkExt, KnownHostsStore};
use crate::session::SshSession;
use crate::sftp::transfer::TransferManager;
use crate::{
    PendingHostKeyResponses, PendingKeyboardResponses, SshConfig, SshSessionInfo, SshWriteChannels,
};

/// SSH 会话管理器:会话实体唯一所有者 + 代次守卫 + 在途 exec 取消句柄。
///
/// 域工具执行器(sidecar 的 `ssh_*` 方法面)与本命令面共用同一张会话表:
/// AI 域工具不再自建连接,而是经 {@link find_asset_session} 复用终端页
/// (`ui.ssh_connect` 带入 asset_id)已连接的会话。
pub struct SshManager {
    pub sessions: Arc<Mutex<HashMap<String, Arc<Mutex<SshSession>>>>>,
    /// 会话写通道(session_id → (代次, 发送端));交互终端 resize / 断开清理用。
    pub channels: SshWriteChannels,
    pub pending_kb: PendingKeyboardResponses,
    pub pending_hostkey: PendingHostKeyResponses,
    attempts: Arc<Mutex<HashMap<String, u64>>>,
    /// 在途 exec 命令的中断句柄:exec_id → 发送端。
    /// 放在 manager 层而不是 SshSession 里:exec 期间 session 锁被持有,
    /// `ssh_exec_abort` 只需要拿这把独立的 map 锁就能中断,不会死锁。
    exec_aborts: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>>,
    /// TOFU 主机密钥策略存储(宿主注入:SQLite / sidecar 自有存储)。
    pub known_hosts: Arc<dyn KnownHostsStore>,
}

impl SshManager {
    /// 建管理器;主机密钥策略存储由宿主注入。
    pub fn new(known_hosts: Arc<dyn KnownHostsStore>) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            channels: Arc::new(Mutex::new(HashMap::new())),
            pending_kb: Arc::new(Mutex::new(HashMap::new())),
            pending_hostkey: Arc::new(Mutex::new(HashMap::new())),
            attempts: Arc::new(Mutex::new(HashMap::new())),
            exec_aborts: Arc::new(Mutex::new(HashMap::new())),
            known_hosts,
        }
    }

    async fn begin_attempt(&self, id: &str) -> u64 {
        let mut attempts = self.attempts.lock().await;
        let next = attempts
            .get(id)
            .copied()
            .unwrap_or_default()
            .wrapping_add(1)
            .max(1);
        attempts.insert(id.to_string(), next);
        next
    }

    /// 读取 id 当前代次(只读,不递增)。无记录返回 None。
    pub async fn current_attempt(&self, id: &str) -> Option<u64> {
        self.attempts.lock().await.get(id).copied()
    }

    async fn invalidate_attempt(&self, id: &str) -> u64 {
        self.begin_attempt(id).await
    }

    /// 代次守卫的失效:仅当 id 当前代次仍等于 `guard` 时才递增,否则不动。
    ///
    /// 修复「关闭→重连失败」竞态:旧会话的 disconnect 在 session 锁上被
    /// 在途 exec 阻塞数秒,期间用户重开连接(新代次);旧 disconnect 醒来后
    /// 若盲目 invalidate 会作废新连接(报 Connection aborted / 删新写通道 /
    /// 删新 MFA 应答通道)。带守卫后旧 disconnect 对新连接零影响。
    /// @returns Some(新代次) = 守卫命中已失效;None = 代次已前移,跳过清理。
    pub async fn invalidate_attempt_if_current(&self, id: &str, guard: u64) -> Option<u64> {
        let mut attempts = self.attempts.lock().await;
        if attempts.get(id).copied() != Some(guard) {
            return None;
        }
        let next = guard.wrapping_add(1).max(1);
        attempts.insert(id.to_string(), next);
        Some(next)
    }

    async fn is_current_attempt(&self, id: &str, generation: u64) -> bool {
        self.attempts.lock().await.get(id).copied() == Some(generation)
    }

    async fn remove_channel_for_attempt(&self, id: &str, generation: u64) {
        let mut channels = self.channels.lock().await;
        if channels
            .get(id)
            .is_some_and(|(current, _)| *current == generation)
        {
            channels.remove(id);
        }
    }

    /// 按代次守卫清理写通道(宿主的 disconnect 路径用)。
    pub async fn remove_write_channel_for_attempt(&self, id: &str, generation: u64) {
        self.remove_channel_for_attempt(id, generation).await;
    }

    /// 丢弃一个会话(死会话自愈路径):从 map 移除 + 作废当前代次 +
    /// 清掉全部 pending 应答通道。供域工具执行器在连接级失败后调用,
    /// 下一次 ensure_ssh_session 会按资产配置重建会话。
    pub async fn drop_session(&self, id: &str) {
        if let Some(session_arc) = self.sessions.lock().await.remove(id) {
            let mut session = session_arc.lock().await;
            session.disconnect();
        }
        self.invalidate_attempt(id).await;
        self.pending_kb.lock().await.remove(id);
        self.pending_hostkey.lock().await.remove(id);
    }

    /// 解析资产当前复用的用户终端会话(新模型 v0.140.0:AI 不自建连接)。
    ///
    /// 同资产多个终端窗口时,按会话 id 序取**第一个存活者**——确定性选择,
    /// 用户新开/关闭窗口后自然顺延。死会话(心跳判死/已断开)跳过。
    /// @returns 会话 id;无存活会话时 None(调用方提示用户去连接)。
    pub async fn find_asset_session(&self, asset_id: &str) -> Option<String> {
        let mut entries: Vec<(String, Arc<Mutex<SshSession>>)> = {
            let sessions = self.sessions.lock().await;
            sessions
                .iter()
                .map(|(id, arc)| (id.clone(), Arc::clone(arc)))
                .collect()
        };
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        for (id, arc) in entries {
            let session = arc.lock().await;
            if session.is_alive() && session.asset_id() == Some(asset_id) {
                return Some(id);
            }
        }
        None
    }

    /// 取指定终端页会话(存活且归属该资产时)供 AI 复用(v0.140.1:
    /// SSH 页面里的 AI 复用那个页面的连接,而不是同资产的任意窗口)。
    /// @returns 会话 id;会话不存在/已死/归属别的资产时 None(调用方回落
    /// {@link find_asset_session} 或提示用户去连接)。
    pub async fn alive_session_for(&self, session_id: &str, asset_id: &str) -> Option<String> {
        let session_arc = {
            let sessions = self.sessions.lock().await;
            sessions.get(session_id).cloned()?
        };
        let session = session_arc.lock().await;
        if session.is_alive() && session.asset_id() == Some(asset_id) {
            Some(session_id.to_string())
        } else {
            None
        }
    }
}

/// 建立 SSH 会话(interactive=true 开 PTY shell,false 为一次性 exec 通道)。
///
/// `asset_id` 是会话归属的 StarHub 资产(终端页连接时带入):AI 域工具据此
/// 复用本会话执行命令,不再自建连接(v0.140.0 新模型)。
///
/// 事件经 `sink` 送出(Tauri 侧是 Emitter,sidecar 侧是 JSON-RPC 通知);
/// 主机密钥策略取自 manager 注入的 [`KnownHostsStore`]。
pub async fn connect_session(
    manager: &SshManager,
    transfer_manager: &TransferManager,
    id: String,
    config: SshConfig,
    asset_id: Option<String>,
    sink: &Arc<dyn EventSink>,
    interactive: bool,
) -> Result<SshSessionInfo, String> {
    let started_at = std::time::Instant::now();
    // 每次显式连接都有独立代次。失败后的 disconnect 只会让旧代次失效,
    // 不会像永久 abandoned 标记那样污染同一 tab/窗口里的下一次重试。
    let attempt_generation = manager.begin_attempt(&id).await;

    // 网络 I/O 在锁外执行 — 否则 connect() 期间持有 sessions 锁会阻塞
    // 所有其他 SSH 操作(resize / disconnect / 新 connect),导致第二个 tab
    // 永远卡在 "Connecting to"。
    let mut session = SshSession::new(config.clone(), Arc::clone(&manager.known_hosts));
    session.set_asset_id(asset_id);
    session
        .connect(
            &id,
            Some(sink),
            &manager.pending_kb,
            &manager.pending_hostkey,
        )
        .await?;
    let auth_elapsed = started_at.elapsed();

    if !manager.is_current_attempt(&id, attempt_generation).await {
        session.disconnect();
        return Err("Connection aborted by client".to_string());
    }
    if interactive {
        if let Err(error) = session
            .open_shell(
                &id,
                attempt_generation,
                Arc::clone(sink),
                manager.channels.clone(),
            )
            .await
        {
            session.disconnect();
            return Err(error);
        }
    }

    tracing::info!(
        session_id = %id,
        host = %config.host,
        port = config.port,
        interactive,
        auth_ms = auth_elapsed.as_millis(),
        total_ms = started_at.elapsed().as_millis(),
        "SSH session connected"
    );

    let info = SshSessionInfo {
        id: id.clone(),
        host: config.host,
        port: config.port,
        username: config.username,
        connected: true,
    };

    // 覆盖同 id 的旧会话前,先注销 TransferManager 里挂在其上的 SFTP 通道。
    // 否则自动重连后 sftp_ensure_session 的 has_session 短路会直接复用旧(已死)通道,
    // 之后所有上传/下载都在死句柄上失败。注销后下一次 ensure 会在新会话上重建通道。
    // 放在取 attempts/sessions 锁之前,避免引入新的锁顺序。
    transfer_manager.unregister_sftp(&id).await;

    // 只在插入 map 时短暂持锁。锁顺序固定为 attempts -> sessions:
    // 先取 attempts 锁(校验代次),再取 sessions 锁插入,
    // 避免持 sessions 锁时 await attempts 锁的锁内 await 反模式,
    // 同时关闭 disconnect / 新 connect 与当前尝试完成之间的竞态窗口。
    let attempts = manager.attempts.lock().await;
    let mut sessions = manager.sessions.lock().await;
    if attempts.get(&id).copied() != Some(attempt_generation) {
        drop(sessions);
        drop(attempts);
        manager
            .remove_channel_for_attempt(&id, attempt_generation)
            .await;
        session.disconnect();
        return Err("Connection aborted by client".to_string());
    }
    // 目标机认证完成后:若本次连接实际走了 keyboard-interactive(MFA),向对应
    // 弹窗发精确的「目标机已连接」信号,让 MFA 弹窗等用户在确认连接成功后复用该
    // 会话。注意:仅认证链(含跳板机/堡垒机选机器后的目标机)全部完成才算成功,
    // 跳板机本身的 MFA 不算「连接成功」。发射前先取 mfa_used,再把 session 移入 Arc。
    let mfa_used = session.mfa_used();
    sessions.insert(id.clone(), Arc::new(Mutex::new(session)));
    if mfa_used {
        sink.emit_ser(&format!("ssh:mfa-connected:{id}"), id.clone());
    }

    Ok(info)
}

/// ssh_exec 的进程内核心(命令面与域工具执行器共用)。
/// `bastion_interactive` = true 时(AI 域工具路径):堡垒机类资产
/// (kb_interactive MFA,普通 exec 通道会被服务端拒绝)改走用户终端 pty —
/// 命令写入用户已连接的同一条 shell,输出经 pty tap 回采(v0.140.0 新模型:
/// AI 不自建连接、不弹「选机器」卡,选机器由用户在自己的终端里完成)。
///
/// `ssh:exec-done` 广播不在这里:该事件是 AI 域工具独有的执行遥测(主壳
/// 执行记录面板的数据源),由 `tools::exec_ssh_command` 在 AI 路径成功后
/// 发射——UI 路径(`ui.ssh_exec` 的 cwd 探测等)不广播,避免混进记录。
pub async fn ssh_exec_core(
    manager: &SshManager,
    id: &str,
    command: &str,
    timeout_sec: Option<u64>,
    exec_id: Option<&str>,
    bastion_interactive: bool,
) -> Result<String, String> {
    // 执行主体:见上方契约注释。
    let result = async {
        // 先从 sessions map 中取出 Arc(只持有主锁一瞬间),然后释放主锁,
        // 再对单个 session 加锁执行命令。这样不同 session 的 exec 和 connect
        // 不会互相阻塞。
        let session_arc = {
            let sessions = manager.sessions.lock().await;
            sessions
                .get(id)
                .cloned()
                .ok_or_else(|| format!("SSH session {} not found", id))?
        };

        let session = session_arc.lock().await;
        // 注册在途取消句柄:普通 exec 与终端 pty 路径统一支持停止生成中断。
        let abort_rx = match exec_id {
            Some(eid) => {
                let (abort_tx, abort_rx) = tokio::sync::oneshot::channel();
                manager
                    .exec_aborts
                    .lock()
                    .await
                    .insert(eid.to_string(), abort_tx);
                Some(abort_rx)
            }
            None => None,
        };
        // 堡垒机 pty 路径:启用 kb_interactive MFA(直连堡垒机或跳板机)时,普通
        // exec 通道被服务端拒绝(Channel send error),命令改写在用户终端的
        // pty 上执行。仅 AI 域工具路径启用(bastion_interactive=true)。
        //
        // 采集期间**不持有会话锁**:tap 发送端与写通道句柄都克隆自会话,
        // 用户的 resize / 断开 / SFTP 操作不被 AI 命令阻塞(锁在采集前释放)。
        let bastion_pty = bastion_interactive && session.is_bastion();
        let tap = if bastion_pty {
            session.pty_output_tap()
        } else {
            None
        };
        let pty_alive = if bastion_pty {
            Some(session.pty_alive_handle())
        } else {
            None
        };
        drop(session);
        let result = if let (Some(tap), Some(pty_alive)) = (tap, pty_alive) {
            let write_tx = {
                let channels = manager.channels.lock().await;
                channels.get(id).map(|(_, tx)| tx.clone())
            };
            match write_tx {
                Some(write_tx) => {
                    SshSession::exec_on_terminal_pty(
                        &write_tx,
                        &tap,
                        &pty_alive,
                        command,
                        timeout_sec.unwrap_or(10),
                        abort_rx,
                    )
                    .await
                }
                None => Err(
                    "[EXEC_FAILED] 终端 shell 写通道不在位(连接可能已断开):请在终端页重新连接后重试"
                        .to_string(),
                ),
            }
        } else {
            // 普通 exec 通道(与交互终端同一条 SSH 连接,互不干扰)。
            let mut session = session_arc.lock().await;
            match abort_rx {
                Some(abort_rx) => {
                    session
                        .exec_abortable(command, timeout_sec.unwrap_or(10), abort_rx)
                        .await
                }
                None => session.exec(command, timeout_sec.unwrap_or(10)).await,
            }
        };
        // 无论结果如何都清理注册,避免 map 泄漏
        if let Some(eid) = exec_id {
            manager.exec_aborts.lock().await.remove(eid);
        }
        result
    }
    .await;

    result
}

/// ssh_exec_abort 的进程内核心(停止生成时中断在途命令)。
pub async fn ssh_exec_abort_core(
    manager: &SshManager,
    id: &str,
    exec_id: &str,
) -> Result<bool, String> {
    // exec_id 由前端按 session 生成且全局唯一(uuid),这里只做防御性的存在性校验
    {
        let sessions = manager.sessions.lock().await;
        if !sessions.contains_key(id) {
            return Err(format!("SSH session {} not found", id));
        }
    }
    let tx = manager.exec_aborts.lock().await.remove(exec_id);
    match tx {
        // 发送失败说明接收端(exec)已结束并清理,视为未中断
        Some(tx) => Ok(tx.send(()).is_ok()),
        None => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::MemoryKnownHostsStore;

    #[tokio::test]
    async fn reconnect_uses_a_fresh_attempt_generation() {
        let manager = SshManager::new(Arc::new(MemoryKnownHostsStore::default()));
        let first = manager.begin_attempt("same-session").await;
        manager.invalidate_attempt("same-session").await;
        assert!(!manager.is_current_attempt("same-session", first).await);

        let retry = manager.begin_attempt("same-session").await;
        assert!(retry > first);
        assert!(manager.is_current_attempt("same-session", retry).await);
    }

    #[tokio::test]
    async fn invalidate_attempt_if_current_only_bumps_matching_generation() {
        // 修复「关闭→重连失败」竞态的守卫语义:旧 disconnect 的失效操作在
        // 新 connect 已开跑(代次前移)后必须被拒绝,而不是作废新连接。
        let manager = SshManager::new(Arc::new(MemoryKnownHostsStore::default()));
        let first = manager.begin_attempt("asset-a").await; // 1
                                                            // 守卫命中:递增到 2
        assert_eq!(
            manager
                .invalidate_attempt_if_current("asset-a", first)
                .await,
            Some(2)
        );
        // 旧代次守卫不再命中:返回 None 且代次不动
        assert_eq!(
            manager
                .invalidate_attempt_if_current("asset-a", first)
                .await,
            None
        );
        assert_eq!(manager.current_attempt("asset-a").await, Some(2));
        // 无记录的 id:current 为 None
        assert_eq!(manager.current_attempt("asset-b").await, None);
    }

    // ---------- find_asset_session(AI 复用用户终端会话,v0.140.0) ----------

    /// 插一条带 asset_id 的会话条目(未连接:handle 为 None,is_alive()=false)。
    async fn insert_session(manager: &SshManager, id: &str, asset_id: Option<&str>) {
        let config: crate::SshConfig = serde_json::from_str(
            r#"{"host":"h","port":22,"username":"u","auth":{"Password":"p"}}"#,
        )
        .unwrap();
        let mut session = SshSession::new(config, Arc::new(MemoryKnownHostsStore::default()));
        session.set_asset_id(asset_id.map(str::to_string));
        manager
            .sessions
            .lock()
            .await
            .insert(id.to_string(), Arc::new(Mutex::new(session)));
    }

    #[tokio::test]
    async fn find_asset_session_returns_none_without_sessions() {
        let manager = SshManager::new(Arc::new(MemoryKnownHostsStore::default()));
        assert_eq!(manager.find_asset_session("asset-a").await, None);
    }

    #[tokio::test]
    async fn find_asset_session_skips_other_assets_and_dead_sessions() {
        let manager = SshManager::new(Arc::new(MemoryKnownHostsStore::default()));
        insert_session(&manager, "asset-b__x1", Some("asset-b")).await;
        // 同资产但未连接(is_alive=false:无连接句柄)——AI 不得复用死会话
        insert_session(&manager, "asset-a__x1", Some("asset-a")).await;
        insert_session(&manager, "no-asset", None).await;
        assert_eq!(manager.find_asset_session("asset-a").await, None);
        assert_eq!(manager.find_asset_session("asset-b").await, None);
        assert_eq!(manager.find_asset_session("ghost").await, None);
    }
}
