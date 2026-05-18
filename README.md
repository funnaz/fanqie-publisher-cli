# 番茄发布助手 CLI

半自动把本地 `.txt` 章节填入番茄作家后台。

## 能力

- 自动扫描浏览器标签页，找到章节编辑页
- 自动填写章节号、章节名、正文
- 自动删除正文第一行的“第x章 章节名”
- 保存草稿后切换到新的章节编辑页，避免覆盖上一章
- 支持断点续传、失败截图、页面诊断
- 支持本地发布前检查

## 安装

```powershell
npm install
```

## 本地检查

```powershell
npm run fanqie -- --dry-run --start 1 --end 10
```

## 保存草稿

```powershell
npm run fanqie -- --draft --start 1 --end 3 --confirm-each --reset
```

## 使用说明

详见 [番茄发布助手使用说明.txt](./番茄发布助手使用说明.txt)。

## 注意

本工具不保存账号密码，不调用非公开接口。你需要在浏览器中手动登录番茄作家后台。
