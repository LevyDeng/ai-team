# AI 小队 · 宣传视频工程 (`promo-video`)

本目录包含「AI 小队（ai-team）」宣传视频（柔雾拿铁 · 朋友分享版）的完整源码与渲染脚本，后续改文案、换截图或调配色都可以直接重出成片。

## 产物
- 成片视频：`dist/ai-team-promo.mp4`（`1920×1080`，`30fps`，H.264 + AAC 中文配音与 UI 音效）
- 关键帧预览：`previews/latte-*.png`

## 目录结构
- `script-data.js`：8 幕文案、第一人称口播稿、字幕与音效时间点（**修改文案直接改此文件**）
- `generate-voice.js`：调用微软神经网络中文语音（`zh-CN-YunxiNeural`）合成配音并自动计算每幕时长
- `generate-sfx.js`：本地合成过场与强调 UI 音效（`whoosh.wav`、`pop.wav`、`chime.wav`）
- `mock-preload.cjs` + `capture-screens.cjs`：使用脱敏 Demo 数据从真实工作台抓取浅色/深色高清截图（不读取 `.runtime/` 个人数据）
- `deck.html`：1920×1080 柔雾拿铁（Palette C）帧精确动效画板
- `render-video.cjs`：支持 `--preview-keyframes` 预览，以及 4 进程并行逐帧渲染 + `ffmpeg` 混音封装最终 MP4

## 重新生成流程
```powershell
Set-Location D:\tools\windows-mcp-server\promo-video
node generate-sfx.js
node generate-voice.js
Set-Location D:\tools\windows-mcp-server
& ".\desktop\node_modules\.bin\electron.cmd" ".\promo-video\capture-screens.cjs"
Set-Location D:\tools\windows-mcp-server\promo-video
node render-video.cjs
```
