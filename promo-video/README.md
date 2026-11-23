# AI 小队 · 宣传视频工程 (`promo-video`)

本目录包含可复用的 1080p 宣传视频源码与渲染脚本，方便后续修改文案、替换截图或重新配音后一键重新出片。

## 产物
- 成片视频：`dist/ai-team-promo.mp4`（1920×1080，30fps，H.264 + AAC 中文配音与 UI 音效）
- 关键帧预览：`previews/`

## 目录结构
- `script-data.js`：8 幕文案、解决痛点说明、配音稿与音效时间点（**修改文案直接改此文件**）
- `generate-voice.js`：使用微软神经网络中文语音（`zh-CN-YunxiNeural`）合成配音并自动计算每幕时长
- `generate-sfx.js`：本地合成过场与强调 UI 音效（`whoosh.wav`、`pop.wav`、`chime.wav`）
- `mock-preload.cjs` + `capture-screens.cjs`：使用脱敏 Demo 数据从真实工作台抓取高清界面截图（不读取 `.runtime/` 个人数据）
- `deck.html`：1920×1080 帧精确动效画板（支持字幕同步、聚焦框、工作流双图切换、浅色/深色分屏滑块）
- `render-video.cjs`：逐帧渲染并经 `ffmpeg` 混音封装最终 MP4

## 重新生成流程
```powershell
Set-Location D:\tools\windows-mcp-server\promo-video
node generate-sfx.js
node generate-voice.js
Set-Location D:\tools\windows-mcp-server
& ".\desktop\node_modules\.bin\electron.cmd" ".\promo-video\capture-screens.cjs"
& ".\desktop\node_modules\.bin\electron.cmd" ".\promo-video\render-video.cjs"
```
