# Apple Music 歌单歌曲提取器

一个 Tampermonkey 用户脚本，用于从 Apple Music 网页歌单提取歌名、歌手和专辑，复制或下载歌曲列表。支持不同国家与地区的 Apple Music 页面，以及网站内部切换歌单。

**[点击安装最新版本](https://raw.githubusercontent.com/ChambersXDU/apple-music-playlist-extractor/main/apple-music-playlist-extractor.user.js)** · [反馈问题](https://github.com/ChambersXDU/apple-music-playlist-extractor/issues) · [自动发布状态](https://github.com/ChambersXDU/apple-music-playlist-extractor/actions)

## 安装与使用

1. 在浏览器中安装 [Tampermonkey](https://www.tampermonkey.net/)。
2. 点击上面的安装链接，在 Tampermonkey 中确认安装。如果浏览器只显示代码，可将代码复制到 Tampermonkey 的新脚本编辑器并保存。
3. 打开 `music.apple.com` 上的歌单，等待歌曲列表加载，点击右下角 🎵。
4. 查看扫描结果后，选择复制表格、CSV、列表、JSON，或下载 CSV / JSON。表格采用制表符分隔，方便粘贴到表格软件；CSV 下载带 UTF-8 BOM，便于 Excel 识别中文。

从原版 v2.1 升级时，脚本名称和 namespace 保持一致。可从安装链接覆盖安装；如果原版没有更新地址，需要手动安装这一次，新版之后会检查更新。

## 相比 v2.1 的改进

- 按歌曲在歌单中的位置与歌曲 ID 收集，保留不同歌手的同名歌曲、不同版本以及有位置编号的重复曲目。只有身份信息缺失时才使用“歌名 + 歌手 + 专辑”组合去重。
- 优先读取与当前歌单 ID 匹配的页面内嵌数据。Apple Music 页面渲染后可能移除该数据；当当前歌曲列表还不完整时，会尝试重新读取当前歌单的 HTML，不执行其中的脚本。
- 对剩余的动态列表逐段滚动，并在每次滚动时收集歌曲，兼容回收旧歌曲行的虚拟列表。结束或取消时恢复滚动位置。
- 有歌曲总数时核对数量；没有总数、加载不完整或超过 120 秒时明确提示，避免把部分结果当作完整歌单。
- 防止并发扫描，支持取消、Esc 关闭和页面切换时取消。弹窗使用 Shadow DOM 隔离样式，并使用文本节点安全渲染歌名等数据。
- CSV 对引号、换行和逗号正确转义，并为可能被表格软件当作公式的字段添加单引号。JSON 保留原始文本。

脚本读取的是页面提供的数据，不绕过登录、地区限制或访问权限。如果网页隐藏歌曲、某些曲目不可用，或 Apple Music 改变页面结构，提取结果可能不完整。可点击“诊断”复制版本、歌单 ID、行数与第一条解析结果，然后提交 Issue；诊断不会自动上传。

## 自动更新

安装文件包含以下元信息：

```text
@updateURL   https://raw.githubusercontent.com/ChambersXDU/apple-music-playlist-extractor/main/apple-music-playlist-extractor.meta.js
@downloadURL https://raw.githubusercontent.com/ChambersXDU/apple-music-playlist-extractor/main/apple-music-playlist-extractor.user.js
```

每次向 `main` 提交源代码、构建脚本、测试或工作流变更，GitHub Actions 会运行测试，生成严格递增的 `3.0.<时间戳>` 版本号，再将 `.user.js` 和 `.meta.js` 一起提交到 `main`。不需要手动改版本号或配置个人访问令牌。测试失败时不会发布新版。仅修改 README 等文档不会发布。

Tampermonkey 根据你设置的检查周期检测并安装新版本；GitHub 提交不会立即推送到浏览器。也可以在 Tampermonkey 中手动检查更新。GitHub Raw 缓存或网络可达性可能导致短暂延迟。更新地址与版本号的作用见 [Tampermonkey 官方文档](https://www.tampermonkey.net/documentation.php?locale=zh_CN#meta:updateURL)。

自动提交使用仓库内置 `GITHUB_TOKEN`，不会再次触发本工作流，参见 [GitHub 官方说明](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow)。发布任务只在主分支运行，PR 只执行测试。主分支如果以后启用保护规则，需允许自动发布提交，或相应调整发布方式；并发人工提交导致推送冲突时，该次发布失败而不覆盖新提交，可以在 Actions 页面重新运行。

## 开发

```sh
git clone git@github.com:ChambersXDU/apple-music-playlist-extractor.git
cd apple-music-playlist-extractor
npm ci
npm test
npm run build
npm run check
```

修改 `src/extractor.js`，然后提交并推送至 `main`。根目录的 `.user.js` 与 `.meta.js` 是生成文件，请不要只修改这两个文件。普通本地构建保留现有版本号；需要本地验证发布时使用 `BUMP_VERSION=1 npm run build`。

测试覆盖真实 Apple Music 歌曲行结构、同名歌曲与重复曲目、结构化数据的歌单归属、虚拟滚动、取消与页面切换、完整性提示、CSV 转义以及安全渲染。运行时没有第三方依赖；jsdom 仅供开发测试。

## 许可

[MIT](LICENSE)
