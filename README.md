# 番茄小说半自动发布助手

这是一个面向番茄小说作者后台的本地半自动发布工具。它可以把本地 `.txt` 章节上传为草稿、从草稿箱发布、或按定时任务自动发布下一批章节。

工具不保存账号密码，不调用非公开接口。所有操作都通过本机浏览器模拟人工点击完成，你需要先在浏览器里登录番茄作者后台。

## 主要功能

- 支持任意小说章节目录。
- 支持本地章节质量检查。
- 自动识别章节号、章节名、正文。
- 自动删除正文第一行的“第 x 章 标题”。
- 支持上传草稿、从草稿箱发布、上传并发布。
- 支持草稿箱翻页查找目标章节。
- 支持发布流程弹窗处理：错别字提示、内容检测、AI 选项、确认发布。
- 支持断点记录，可查看上传到哪章、发布到哪章。
- 支持 Web 控制台。
- 支持定时任务：每 2/30/60/120/240 分钟自动执行下一批。
- 任务完成后自动关闭脚本打开的浏览器，方便下一轮自动化。

## 安装

```powershell
npm install
```

## 启动 Web 控制台

```powershell
npm run web
```

打开：

```text
http://localhost:3899
```

## 章节目录格式

推荐结构：

```text
某本书/
  chapters/
    001-第一章 标题.txt
    002-第二章 标题.txt
```

也支持分文件夹：

```text
某本书/
  chapters/
    001-020/
      001-第一章 标题.txt
      002-第二章 标题.txt
```

正文推荐第一行：

```text
第1章 标题

正文内容……
```

脚本会拆成：

- 章节号：`1`
- 章节名：`标题`
- 正文：删除第一行后上传

## 常用命令

本地检查：

```powershell
npm run fanqie -- --chapters "D:\novels\某本书\chapters" --dry-run --start 1 --end 10
```

上传草稿：

```powershell
npm run fanqie -- --chapters "D:\novels\某本书\chapters" --draft --start 1 --end 3 --confirm-each --reset
```

从草稿箱发布：

```powershell
npm run fanqie -- --chapters "D:\novels\某本书\chapters" --publish-drafts --start 1 --end 3 --confirm-each --reset
```

上传并发布：

```powershell
npm run fanqie -- --chapters "D:\novels\某本书\chapters" --upload-and-publish --start 1 --end 3 --confirm-each --reset
```

## 定时发布

在 Web 控制台里创建定时任务：

1. 填写章节目录、书名、作品后台 URL、截止章节。
2. 选择间隔：2/30/60/120/240 分钟。
3. 选择定时模式。
4. 设置每次发布章节数。
5. 点击“创建定时发布”。

定时模式说明：

- `发布草稿箱`：从草稿箱找对应章节并发布。作品后台 URL 填“章节管理/草稿箱”页面。
- `上传并发布`：先填入章节内容，再直接走发布流程。作品后台 URL 填“新建章节”页面。

定时任务会根据当前已发布进度自动计算下一批章节。任务完成后会自动关闭脚本打开的浏览器。

## 使用手册

完整说明见：[番茄发布助手使用手册.md](./番茄发布助手使用手册.md)

