# 番茄小说半自动发布助手 CLI

把任意本地 `.txt` 小说章节半自动填入番茄作家后台。

## 功能

- 支持任意小说章节目录
- 自动扫描浏览器标签页，找到章节编辑页
- 草稿上传时如果还在章节管理页，会尝试自动点击“新建章节”
- 自动填写章节号、章节名、正文
- 自动删除正文第一行的“第x章 章节名”
- 保存草稿后切换到新的章节编辑页，避免覆盖上一章
- 可从草稿箱/章节管理页按章节范围发布已保存草稿
- 发布草稿时会从草稿箱列表点击编辑图标进入草稿编辑页
- 每发布一章后自动切回草稿箱继续下一章
- 草稿过多时会尝试自动翻页查找目标章节
- 支持断点续传、失败截图、页面诊断
- 支持发布前质量检查
- 支持 JSON 配置文件

## 安装

```powershell
npm install
```

## 章节格式

推荐目录：

```text
某本书/
  chapters/
    001-第1章 开篇标题.txt
    002-第2章 第二章标题.txt
```

推荐正文第一行：

```text
第1章 开篇标题

正文内容……
```

脚本会自动拆成：

- 章节号：`1`
- 章节名：`开篇标题`
- 正文：删除第一行后上传

## 本地检查

```powershell
npm run fanqie -- --chapters "D:\novels\某本书\chapters" --dry-run --start 1 --end 10
```

## 保存草稿

```powershell
npm run fanqie -- --chapters "D:\novels\某本书\chapters" --draft --start 1 --end 3 --confirm-each --reset
```

## 发布草稿箱章节

```powershell
npm run fanqie -- --chapters "D:\novels\某本书\chapters" --publish-drafts --start 1 --end 3 --confirm-each --reset
```

运行后手动进入番茄后台的草稿箱或章节管理页，再回命令窗口按回车。

## Web 控制台

```powershell
npm run web
```

打开：

```text
http://localhost:3899
```

Web 控制台支持：

- 填写章节目录、起止章节、模式
- 启动上传草稿或发布草稿任务
- 支持直接发布：先填写章节内容，再执行发布弹窗流程
- 点击“继续 / 回车”响应脚本等待
- 实时查看日志
- 查看每个章节目录已上传到哪章、已发布到哪章
- 创建定时发布任务：每 2/30/60/120/240 分钟自动执行“发布草稿箱”或“上传并发布”

已验证流程：从草稿箱列表发布第 15-17 章成功。

## 使用配置文件

复制 `fanqie.config.example.json` 为 `fanqie.config.json`，改成你的书名和章节目录。

```powershell
npm run fanqie -- --config ".\fanqie.config.json" --dry-run --start 1 --end 10
npm run fanqie -- --config ".\fanqie.config.json" --draft --start 1 --end 3 --confirm-each --reset
```

## 使用说明

详见 [番茄发布助手使用说明.txt](./番茄发布助手使用说明.txt)。

## 注意

本工具不保存账号密码，不调用非公开接口。你需要在浏览器中手动登录番茄作家后台。
