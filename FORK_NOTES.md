# 本 fork 的改动说明（Fork Notes）

> 本文件记录相对于上游 [pot-app/pot-desktop](https://github.com/pot-app/pot-desktop) 的本地改动。
> 上游 README 保持原样，便于以后 merge upstream。

## 3. 启动体积优化（按窗口/按需加载）

翻译窗口是高频入口，原来它会把所有窗口和识别服务的代码一起解析。现在按需加载：

| 改动             | 做法                                                                                                      | 效果                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 窗口级懒加载     | `App.jsx` 里 `Config / Recognize / Screenshot / Updater` 改为 `React.lazy`，只有 `Translate` 保持同步加载 | 划词窗口少解析 ~535KB                                                       |
| 识别服务按需加载 | `SourceArea` 里 `services/recognize` 改成进入「截图/图片翻译」分支时才 `import()`                         | 再减少 ~217KB，识别服务单独成 chunk（~204KB），只在图片翻译或识别窗口才加载 |

实测（`vite build` 后统计各窗口实际下载的 JS，解压后大小）：

-   翻译窗口：**2187KB → 1428KB**（−34%），gzip 603KB → 412KB（−32%）
-   配置窗口：1923KB（会额外加载 Config 和识别服务 chunk，属于低频窗口）

生词本（collection）**没有做删除**：源码 436 行 / 15.7KB，实测打包后仅 7.2KB（约 0.4%），而且默认 `collection_service_list` 为空时它根本不渲染任何 UI，删掉对响应速度没有可感知影响。

## 2. 翻译窗口的侧边历史面板

-   **入口**：翻译窗口左上角的历史图标。打开后窗口横向扩宽 264px，历史面板停靠在右侧；再点一次或点面板右上角的 × 收起。
-   **数据**：直接读同一份 `sqlite:history.db`（最近 50 条）。翻译完成时 `TargetArea` 广播 `history_updated`，面板自动刷新，不用重开窗口。
-   **展示策略**：
    -   原文折叠最多 3 行；只有超长（> 48 字符或 > 3 行）才出现「展开 / 收起」，单词、短语这类短内容本来就能完整显示；
    -   译文折叠 2 行，展开时一起展开；
    -   时间显示为「刚刚 / N 分钟前 / N 小时前 / MM-DD HH:mm」。
-   **状态保持**：`translate_history_open` 记住上次是否打开，`translate_window_width` 记住展开后的宽度 —— Rust 在每次划词时会按配置重置窗口尺寸，写回配置才能避免面板被挤回去。
-   **预览**：`src/dev/mock-tauri.js` 里对 `SELECT ... FROM history` 返回 4 条假数据（长文 / 单词 / 中文长摘要 / 短语），方便截图和调样式。
-   **交互细节**：顶栏三个按钮带 Tooltip（图钉 / 历史 / 关闭）；语言栏在滚动时吸顶；面板内 `Esc` 优先关面板（捕获阶段拦截，不会误关翻译窗口）；条目支持 Tab 聚焦 + Enter/空格展开；单条展开只重渲染该条（`React.memo`），列表不会整体重排。
-   **失败态**：历史数据库读取失败时显示「历史记录读取失败 + 重试」，不再静默变成空列表。

## 1. 内网直连：挂代理时自动绕过内网地址

### 问题

在公司挂着梯子（mihomo / Clash，监听 `127.0.0.1:9674` 并设置为 Windows 系统代理）时，
Pot 访问内网部署的翻译模型（如 `http://10.200.8.204:9090`）会被代理接管，
约 60 秒后返回 502。现象是：`curl`、Node 都能连上内网，只有 Pot 不行。

### 根因

Pot 的所有 HTTP 请求（内置翻译服务、插件 `utils.tauriFetch`、更新检查）最终都走
Rust 的 [reqwest](https://github.com/seanmonstar/reqwest)，而不是 WebView 自己的网络栈。
reqwest 在 Windows 上的系统代理探测只读注册表这两个值：

```
HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings
    ProxyEnable  = 1
    ProxyServer  = 127.0.0.1:9674
```

**它不读 `ProxyOverride`**（也就是 Windows 设置界面里的「跳过以下地址」）。
所以梯子写进去的 `10.*` 绕过规则对 Pot 完全无效，内网请求必然被转发给 mihomo。

但同时，reqwest 每次构建 HTTP 客户端时都会重新读取 `NO_PROXY` 环境变量，
并且它的匹配器支持 IP、CIDR、域名和 `.domain` 前缀。这就是可以利用的点。

### 改法

启动时把「内网直连」列表写进进程的 `NO_PROXY`，让 reqwest 按目标主机决定是否走代理：

| 目标                                            | 行为                            |
| ----------------------------------------------- | ------------------------------- |
| `localhost`、`127.0.0.1`、`::1`                 | 直连                            |
| `10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16` | 直连                            |
| 其他（国外网站）                                | 照旧走系统代理 / Pot 设置的代理 |

改动文件：

-   `src-tauri/src/proxy.rs`（新增）：`merge_no_proxy()` / `apply_no_proxy()` / `apply_proxy_settings` 命令，含单元测试
-   `src-tauri/src/main.rs`：`mod proxy;`，在 `init_config` 之后、任何网络请求之前调用 `apply_no_proxy()`；注册 `apply_proxy_settings` 命令
-   `src-tauri/src/cmd.rs`：`set_proxy()` / `unset_proxy()` 统一通过 `proxy::apply_no_proxy()` 设置 `no_proxy`，所以 **关闭 Pot 内置代理后内网直连依然生效**（系统代理来自注册表，与 Pot 的开关无关）
-   `src/window/Config/pages/General/index.jsx`：设置 → 通用 → 网络代理 新增「内网直连（绕过代理）」输入框；修改代理相关设置后调用 `apply_proxy_settings`，**立即生效，不必重启**
-   `src/i18n/locales/en_US.json`、`zh_CN.json`：新增文案

### 配置

| key            | 默认值                                                            | 说明                            |
| -------------- | ----------------------------------------------------------------- | ------------------------------- |
| `proxy_bypass` | `localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16` | 逗号分隔，支持 IP / CIDR / 域名 |

留空会回落到上面的默认值；它和原有的 `no_proxy` 字段会**合并去重**后一起写进
`NO_PROXY` / `no_proxy`。

### 浏览器预览（不装 Rust 也能改 UI）

```bash
pnpm install
pnpm dev:web
```

打开 <http://localhost:1420/?window=config>（服务跑在 WSL 里时，Windows 浏览器直接访问 `localhost:1420` 即可）。

-   `?window=config|translate|recognize|screenshot|updater` 选择预览的窗口，默认 `config`；
-   `?os=Windows_NT|Darwin|Linux` 模拟系统，默认 `Windows_NT`（和公司机器一致，UI 分支才正确）；
-   配置读写走 localStorage（键名 `pot-preview:store`），刷新不丢；清掉浏览器存储即恢复默认；
-   所有 Tauri API 由 `src/dev/mock-tauri.js` 提供：`invoke` 返回假数据，`proxy_test` 会发真实请求，但浏览器里没有代理分流，结论仅供参考；
-   该 mock 只在 `vite --mode preview` 下通过 `vite.config.js` 的 alias 生效，`pnpm tauri dev` / `pnpm build` 完全不受影响。

### 无头截图（改完 UI 后自查）

一次性依赖（Ubuntu 上需要 root）：

```bash
sudo apt-get install -y libnss3 libnspr4 libasound2t64 libatk-bridge2.0-0t64 libcups2t64 fonts-noto-cjk
```

Playwright 的 Chromium 装在 `.git/pw-browsers`（不入库），截图脚本在 `.git/shot.mjs`：

```bash
PLAYWRIGHT_BROWSERS_PATH=$PWD/.git/pw-browsers node .git/shot.mjs
# 输出：.git/shots/{config-general,config-proxy-test,translate,config-general-dark}.png
```

脚本会顺带抓 `pageerror` / `console.error`，白屏或接口报错能第一时间看到。

已知差异：浏览器是 Chromium，Pot 用的是 WebView2/WebKit。字体、滚动条、`backdrop-filter`、拖拽等细节仍需在真实构建里再确认一次。

### 验证

1. 编译：`pnpm install && pnpm tauri dev`
2. 启动后看日志（设置 → 关于 → 查看日志），应出现一行：
   `[proxy] NO_PROXY=localhost,127.0.0.1,::1,10.0.0.0/8,192.168.0.0/16,172.16.0.0/12`
3. 在 设置 → 通用 → 网络代理 的「测试地址」里填一个内网地址（例如 `http://10.200.8.204:9090/v1/models`），点「测试」：
    - 「直连正常（已绕过代理）」→ 绕过生效；
    - 「请求被代理拦截」→ 地址不在绕过列表，把它加进「内网直连」；
    - 「只有走代理才能访问」→ 该地址是外网，属于正常情况。
4. 挂着梯子，用内置服务翻译一次外网内容（应仍然能走代理），再用 Hy-MT2 插件翻译一次内网请求（应直接连通、不再 502）。
5. 若插件仍报 502，检查是否插件里填了 `baseUrl`（填了就强制直连，见插件 README），以及日志里的 `NO_PROXY` 是否包含目标网段。

### 与插件的关系

改完之后，Hy-MT2 插件里的本地 Node 中继（`relay/relay-hymt2.js` + `wscript` 自动拉起）
**不再必需**。插件的 `no-relay` 分支已经把这套逻辑删掉：始终直连，内网直连完全由本补丁负责；
`main` 分支保留带中继的实现，用于未修改的官方 Pot。
