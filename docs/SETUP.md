# 安装与连接指南

## 本机使用

1. 在 Windows 上安装带 npm 的 Node.js 24。在 PowerShell 里用 `node --version` 和 `npm --version` 确认可用。
2. 下载或克隆仓库，解压到自己可写的目录，再双击根目录中的 `ai-team.cmd`。首次运行会安装 Electron 和项目依赖。
3. 在「角色 → 连接配置」选择 Agent，将运行位置设为「本机」。安装所选 Agent 后，按提示登录。API 模式需要该服务的 API 密钥和模型 ID。
4. 新建项目，在项目设置中为「本机」选一个目录，将角色加入项目。新建对话后发送一条短消息，确认能得到回复。

快捷方式可通过 `Create-DesktopShortcut.ps1` 生成。使用官方 CLI 登录时，按提供方的网页或终端步骤完成授权。

## Linux VPS 上的角色

已有 Linux VPS 和可用的 Claude Code 或 Codex CLI 时，可在工作台的「位置」里添加 SSH 连接。

1. 填写服务器地址、端口、SSH 用户和私钥路径。首次连接前，使用可信来源核对服务器指纹。
2. 在 VPS 上安装所选 Agent。
3. 在项目设置中添加该位置对应的远程目录，比如 `~/projects/my-project`。首次启动远程任务或打开项目终端和文件时，工作台会用该 SSH 用户创建缺失的目录。需要在 VPS 上使用已有代码时，请将项目设为代码所在目录，或先把代码同步到配置的目录。
4. 在角色设置中选择这个运行位置，再点「登录原生账号」，按远端终端的提示完成角色登录。先发送一条短消息，确认连接和登录状态。

项目可以同时有本机和多个远程目录。只使用 VPS 的角色只需要对应的 VPS 目录。

## 自动安装托管环境

想搭建带 Windows-MCP 的托管 VPS 环境时，先准备可通过 SSH 登录的 Ubuntu VPS，再双击根目录的 `setup-relay-desk.cmd`。脚本会询问服务器信息，安装或检查所需组件，并引导完成登录。

可先查看安装计划：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Setup-RelayDesk.ps1 -Plan
```

命令行选项及可保留的本地配置见[进阶配置与排障](ADVANCED.md)。安装后继续按[工作台使用说明](Relay-Desk-Workbench.md)创建角色、项目和对话。
