# 灵动岛 (Q-Dynamic-Island)

Windows 桌面悬浮「灵动岛」—— 显示并控制正在播放的音乐，带悬停放大、贴顶收拢、点击穿透、波浪可视化等动效。

- 显示：标题 / 歌手 / 封面 / 进度 / 播放状态
- 控制：播放 / 暂停 / 上一首 / 下一首
- 悬停放大、拖到屏幕边缘贴顶收拢、右键菜单（缩放 / 背景透明度 / 固定 / 波浪 / 退出）

## 支持的音乐播放器

| 播放器 | 说明 |
|---|---|
| 汽水音乐 | ✅ 走系统媒体会话（GSMTC），信息最全 |
| QQ音乐 / 酷狗音乐 | ✅ 接 GSMTC 时信息最全；无会话时读窗口标题，封面在线搜索，播放状态乐观估算 |
| 网易云音乐 | ❌ 暂不支持（客户端禁用了系统媒体会话与媒体键，无法可靠控制） |

## 环境要求

- **Windows 10 / 11**（依赖系统媒体会话 WinRT API，仅 Windows）
- Node.js + npm
- **无需 .NET SDK**（音乐桥接走 PowerShell，见下文）

## 安装 & 运行

```bash
git clone https://github.com/StrangeHamburger/Q-Dynamic-Island.git
cd Q-Dynamic-Island
npm install
npm start
```

### 国内加速（Electron 二进制默认从 GitHub 下载会失败）

`npm install` 前加环境变量，二选一：

```bash
# 方式一：一次性
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install

# 方式二：全局设置一次，之后 npm install 都不用再带
npm config set electron_mirror https://npmmirror.com/mirrors/electron/
npm install
```

## 使用

- 左键点击岛：播放 / 暂停 / 切歌
- 悬停：放大
- 拖到屏幕顶端：贴顶收拢成细条
- 右键：菜单（缩放、背景透明度、固定位置、波浪可视化、退出）
- 托盘图标：显示 / 退出

## 说明与限制

- 仅 Windows。
- 封面在线搜索需要联网。
- QQ音乐 / 酷狗音乐无系统媒体会话时，播放状态为乐观估算（真实暂停态读不到）。

## 开发注意

- **`.ps1` 文件必须带 UTF-8 BOM**：Windows PowerShell 5.1 会把无 BOM 的 UTF-8 `.ps1` 按 GBK 读，中文字符串会乱码导致解析错误。用编辑器改 `.ps1` 后务必存成「UTF-8 with BOM」。
- 音乐桥接：`music.js` 会 spawn 一个持久 PowerShell 进程 `gsmtc.ps1`，用行协议（`get/play/pause/next/prev/toggle/quit` → JSON）通信，无需额外构建步骤。
