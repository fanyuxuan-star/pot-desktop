use crate::cmd::{set_proxy, unset_proxy};
use crate::config::get;
use log::info;
use std::env;

/// 默认「内网直连」列表：回环地址 + RFC1918 私网段。
/// 内网服务（例如公司部署的翻译模型）走这些地址时永远不经过代理。
pub const DEFAULT_PROXY_BYPASS: &str =
    "localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16";

fn split_list<'a>(raw: &'a str) -> impl Iterator<Item = &'a str> {
    raw.split(',').map(str::trim).filter(|item| !item.is_empty())
}

/// 合并用户填写的 no_proxy 与「内网直连」列表，去重并保持顺序。
pub fn merge_no_proxy(user: &str, bypass: &str) -> String {
    let mut merged: Vec<&str> = Vec::new();
    for item in split_list(user).chain(split_list(bypass)) {
        if !merged
            .iter()
            .any(|existing: &&str| existing.eq_ignore_ascii_case(item))
        {
            merged.push(item);
        }
    }
    merged.join(",")
}

fn config_str(key: &str) -> Option<String> {
    get(key).and_then(|value| value.as_str().map(str::to_string))
}

/// 把「内网直连」列表写进 NO_PROXY。
///
/// Windows 上 reqwest（Tauri 的 http 模块以及本应用自己发起的请求都基于它）
/// 只读取注册表里的 ProxyEnable / ProxyServer，**不读取 ProxyOverride**，
/// 所以 mihomo 之类工具写入的「10.* 直连」对 Pot 无效。
/// 但 reqwest 每次构建 Client 时都会重新读取 NO_PROXY，并且支持 IP / CIDR /
/// 域名匹配，因此在进程内设置这个环境变量即可让所有请求按目标地址决定是否走代理：
/// 内网直连，外网仍然走系统代理。
pub fn apply_no_proxy() {
    let no_proxy = config_str("no_proxy").unwrap_or_default();
    let bypass = config_str("proxy_bypass").unwrap_or_else(|| DEFAULT_PROXY_BYPASS.to_string());
    let merged = merge_no_proxy(&no_proxy, &bypass);
    env::set_var("NO_PROXY", &merged);
    env::set_var("no_proxy", &merged);
    info!("[proxy] NO_PROXY={}", merged);
}

/// 前端修改代理相关设置后调用，让改动立即生效（不必重启应用）。
#[tauri::command]
pub fn apply_proxy_settings() -> Result<bool, ()> {
    let enabled = get("proxy_enable")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let has_endpoint = get("proxy_host")
        .map(|value| !value.as_str().unwrap_or("").trim().is_empty())
        .unwrap_or(false)
        && get("proxy_port")
            .map(|value| value.as_i64().is_some())
            .unwrap_or(false);

    if enabled && has_endpoint {
        set_proxy()?;
    } else {
        unset_proxy()?;
    }
    Ok(true)
}

/// 单次探测结果：状态码（拿不到就是 None）、耗时、响应或错误详情。
#[derive(serde::Serialize)]
pub struct ProxyTestResult {
    verdict: String,
    direct_status: Option<u16>,
    direct_ms: u128,
    direct_detail: String,
    routed_status: Option<u16>,
    routed_ms: u128,
    routed_detail: String,
}

async fn probe(url: &str, bypass_proxy: bool) -> (Option<u16>, u128, String) {
    use std::time::{Duration, Instant};

    let builder = reqwest::Client::builder().timeout(Duration::from_secs(8));
    let builder = if bypass_proxy {
        builder.no_proxy()
    } else {
        builder
    };
    let client = match builder.build() {
        Ok(client) => client,
        Err(error) => return (None, 0, format!("创建 HTTP 客户端失败：{error}")),
    };

    let started = Instant::now();
    match client.get(url).send().await {
        Ok(response) => {
            let status = response.status().as_u16();
            let elapsed = started.elapsed().as_millis();
            let body = response.text().await.unwrap_or_default();
            let detail = body.chars().take(160).collect::<String>();
            (Some(status), elapsed, detail)
        }
        Err(error) => (None, started.elapsed().as_millis(), format!("{error}")),
    }
}

/// 对比「强制直连」与「按当前代理设置走」两种结果，给出结论。
fn verdict_of(direct_status: Option<u16>, routed_status: Option<u16>) -> &'static str {
    match (direct_status, routed_status) {
        (Some(direct), Some(routed)) if direct == routed => "bypass",
        (Some(_), Some(_)) => "intercepted",
        (Some(_), None) => "intercepted",
        (None, Some(_)) => "proxy_only",
        (None, None) => "unreachable",
    }
}

/// 设置页「测试」按钮：分别用直连和当前代理设置访问一次目标地址，
/// 用于确认内网地址到底是被代理拦住了，还是本来就不通。
#[tauri::command]
pub async fn proxy_test(url: String) -> Result<ProxyTestResult, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("请先填写测试地址".to_string());
    }
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("测试地址需要以 http:// 或 https:// 开头".to_string());
    }

    let (direct_status, direct_ms, direct_detail) = probe(&url, true).await;
    let (routed_status, routed_ms, routed_detail) = probe(&url, false).await;

    Ok(ProxyTestResult {
        verdict: verdict_of(direct_status, routed_status).to_string(),
        direct_status,
        direct_ms,
        direct_detail,
        routed_status,
        routed_ms,
        routed_detail,
    })
}

#[cfg(test)]
mod tests {
    use super::merge_no_proxy;

    #[test]
    fn merges_and_dedupes_in_order() {
        assert_eq!(
            merge_no_proxy("localhost, 127.0.0.1", "localhost,10.0.0.0/8"),
            "localhost,127.0.0.1,10.0.0.0/8"
        );
        assert_eq!(merge_no_proxy("", "10.0.0.0/8"), "10.0.0.0/8");
        assert_eq!(merge_no_proxy(" a , b ", "b,c"), "a,b,c");
        assert_eq!(merge_no_proxy("", ""), "");
    }

    #[test]
    fn keeps_user_entries_first() {
        assert_eq!(
            merge_no_proxy("gitlab.corp", "localhost"),
            "gitlab.corp,localhost"
        );
    }

    #[test]
    fn classifies_probe_results() {
        use super::verdict_of;
        assert_eq!(verdict_of(Some(200), Some(200)), "bypass");
        assert_eq!(verdict_of(Some(200), Some(502)), "intercepted");
        assert_eq!(verdict_of(Some(200), None), "intercepted");
        assert_eq!(verdict_of(None, Some(200)), "proxy_only");
        assert_eq!(verdict_of(None, None), "unreachable");
    }
}
