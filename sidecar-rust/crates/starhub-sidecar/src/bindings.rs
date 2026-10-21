//! 会话 → 资产绑定(从 `src-tauri/src/harness/mod.rs::HostBridgeState` 的绑定
//! 逻辑平移,去 Tauri 化 M1;纯逻辑零改动)。
//!
//! dsh 侧 `bind_asset_context` / `open_connection` 把「当前会话 @ 了哪个资产」
//! 记在这里;域工具执行时若参数没带 assetId,就沿 subagent 父链向上解析
//! (子代理会话继承父会话绑定)。环引用(异常通知)以 visited 集防御。
//!
//! v0.140.1:绑定可附带**终端页会话 id**(`terminalSessionId`)——SSH 终端页里
//! 的 AI 助手据此复用**那个页面**的连接,而不是同资产的任意一个窗口。

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

/// 一条会话绑定:资产类型 + 资产 id + 可选的终端页会话 id。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionBinding {
    pub asset_type: String,
    pub asset_id: String,
    /// 发起绑定的终端页 SSH 会话 id(SSH 助手场景;主壳 AI 等无页面上下文为 None)。
    pub terminal_session_id: Option<String>,
}

/// 会话绑定表:session_id → 绑定。
#[derive(Default)]
pub struct SessionBindings {
    bindings: Mutex<HashMap<String, SessionBinding>>,
    /// subagent 子 → 父会话映射。
    subagent_parents: Mutex<HashMap<String, String>>,
}

impl SessionBindings {
    pub fn new() -> Self {
        Self::default()
    }

    /// 记录 会话→资产 绑定;asset_id 为空视为解除绑定。
    /// `terminal_session_id` 为该会话所在终端页的 SSH 会话 id(可选)。
    pub fn bind(
        &self,
        session_id: &str,
        asset_type: &str,
        asset_id: &str,
        terminal_session_id: Option<&str>,
    ) {
        let mut bindings = self.bindings.lock().unwrap();
        if asset_id.trim().is_empty() {
            bindings.remove(session_id);
        } else {
            bindings.insert(
                session_id.to_string(),
                SessionBinding {
                    asset_type: asset_type.to_string(),
                    asset_id: asset_id.to_string(),
                    terminal_session_id: terminal_session_id
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string),
                },
            );
        }
    }

    /// 记录 subagent 子→父会话映射(子代理会话继承父会话的资产绑定)。
    pub fn record_subagent_parent(&self, child_session_id: &str, parent_session_id: &str) {
        self.subagent_parents
            .lock()
            .unwrap()
            .insert(child_session_id.to_string(), parent_session_id.to_string());
    }

    /// 沿 subagent 父链向上解析会话的资产绑定(子代理继承父会话绑定);
    /// 无绑定返回 None。环引用(异常通知)以 visited 集防御。
    pub fn resolve(&self, session_id: &str) -> Option<SessionBinding> {
        let mut current = session_id.to_string();
        let mut visited = HashSet::new();
        loop {
            if let Some(binding) = self.bindings.lock().unwrap().get(&current) {
                return Some(binding.clone());
            }
            if !visited.insert(current.clone()) {
                return None;
            }
            let parent = self.subagent_parents.lock().unwrap().get(&current)?.clone();
            current = parent;
        }
    }

    /// 沿 subagent 父链解析会话绑定的终端页会话 id(v0.140.1:
    /// SSH 页面里的 AI 复用那个页面的连接)。无绑定/未附带的会话返回 None。
    pub fn resolve_terminal_session(&self, session_id: &str) -> Option<String> {
        self.resolve(session_id)
            .and_then(|binding| binding.terminal_session_id)
    }

    /// 解除一个会话的绑定(会话结束/切换资产时)。
    pub fn unbind(&self, session_id: &str) {
        self.bindings.lock().unwrap().remove(session_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bind_and_resolve_roundtrip() {
        let bindings = SessionBindings::new();
        assert_eq!(bindings.resolve("root"), None);
        bindings.bind("root", "ssh", "a1", None);
        assert_eq!(
            bindings.resolve("root"),
            Some(SessionBinding {
                asset_type: "ssh".into(),
                asset_id: "a1".into(),
                terminal_session_id: None,
            })
        );
        // 空 asset_id = 解绑
        bindings.bind("root", "ssh", "", None);
        assert_eq!(bindings.resolve("root"), None);
    }

    #[test]
    fn terminal_session_rides_the_binding_and_inherits_down_the_chain() {
        let bindings = SessionBindings::new();
        bindings.bind("root", "ssh", "a1", Some("a1__k3f9a2"));
        assert_eq!(
            bindings.resolve_terminal_session("root"),
            Some("a1__k3f9a2".to_string())
        );
        // 子代理(无自己的绑定)继承父会话的终端页会话
        bindings.record_subagent_parent("child-1", "root");
        assert_eq!(
            bindings.resolve_terminal_session("child-1"),
            Some("a1__k3f9a2".to_string())
        );
        // 空白串等同未附带
        bindings.bind("root", "ssh", "a1", Some("  "));
        assert_eq!(bindings.resolve_terminal_session("root"), None);
        // 未绑定的会话:None
        assert_eq!(bindings.resolve_terminal_session("ghost"), None);
    }

    #[test]
    fn subagent_child_inherits_parent_binding() {
        let bindings = SessionBindings::new();
        bindings.bind("root", "db", "db-1", None);
        bindings.record_subagent_parent("child-1", "root");
        bindings.record_subagent_parent("child-2", "child-1");
        assert_eq!(
            bindings.resolve("child-2").map(|b| (b.asset_type, b.asset_id)),
            Some(("db".into(), "db-1".into()))
        );
        // 子会话自己的绑定优先于父链
        bindings.bind("child-1", "ssh", "ssh-1", None);
        assert_eq!(
            bindings.resolve("child-2").map(|b| (b.asset_type, b.asset_id)),
            Some(("ssh".into(), "ssh-1".into()))
        );
    }

    #[test]
    fn cycle_is_terminated_by_the_visited_set() {
        let bindings = SessionBindings::new();
        bindings.record_subagent_parent("a", "b");
        bindings.record_subagent_parent("b", "a");
        assert_eq!(bindings.resolve("a"), None);
    }

    #[test]
    fn unbind_only_removes_the_target_session() {
        let bindings = SessionBindings::new();
        bindings.bind("root", "ssh", "a1", None);
        bindings.record_subagent_parent("child", "root");
        bindings.unbind("child");
        assert_eq!(
            bindings.resolve("child").map(|b| b.asset_id),
            Some("a1".into())
        );
        bindings.unbind("root");
        assert_eq!(bindings.resolve("child"), None);
    }
}
