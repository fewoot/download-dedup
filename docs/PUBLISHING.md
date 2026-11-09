# 用 GitHub Desktop 发布

这个目录已经初始化成 Git 仓库，当前分支是 `main`，并且已经有一个初始提交，可以直接用 GitHub Desktop 发布。

## 1. 添加本地仓库

1. 打开 GitHub Desktop。
2. 菜单 **File → Add Local Repository…**。
3. 选择这个目录：

   ```text
   D:\deepseek harness workplaces\下载内容重复\download-dedup
   ```

4. 如果提示路径不是 Git 仓库，说明选错了层级，请确认选择的是包含 `.git` 的 `download-dedup` 文件夹。

## 2. 发布

1. 点击右上角 **Publish repository**。
2. 仓库名建议：`download-dedup`。
3. 选择 Public 或 Private。
4. 点 **Publish repository**。

发布后，GitHub 上会出现：

```text
https://github.com/<你的用户名>/download-dedup
```

## 3. 更新 README 里的安装地址

把 `README.md` 中的占位符替换成实际地址：

```text
https://raw.githubusercontent.com/<你的用户名>/download-dedup/main/download-dedup.user.js
```

如果默认分支不是 `main`，把地址里的 `main` 换成实际分支名。

## 4. 可选：让 Tampermonkey 自动更新

在 `download-dedup.user.js` 头部加入下面几行，把用户名和仓库名换成实际值：

```js
// @homepageURL  https://github.com/<你的用户名>/download-dedup
// @supportURL   https://github.com/<你的用户名>/download-dedup/issues
// @downloadURL  https://raw.githubusercontent.com/<你的用户名>/download-dedup/main/download-dedup.user.js
// @updateURL    https://raw.githubusercontent.com/<你的用户名>/download-dedup/main/download-dedup.user.js
```

这样以后更新 `download-dedup.user.js` 并发布新版本时，Tampermonkey 可以检查更新。

## 5. 可选：创建版本标签

GitHub Desktop 对标签的支持比较有限，推荐在 GitHub 网页上操作：

1. 打开仓库页面。
2. 右侧 **Releases → Draft a new release**。
3. Tag 填 `v1.1.0`，Target 选 `main`。
4. 标题填 `v1.1.0`，说明可以从 `CHANGELOG.md` 复制。
5. 发布。

## 检查清单

- [ ] GitHub Desktop 能正常打开仓库
- [ ] 已发布到 GitHub
- [ ] README 的 Raw 安装地址已替换
- [ ] 可选：脚本头部已加入 `@downloadURL` / `@updateURL`
- [ ] 可选：已创建 `v1.1.0` Release
