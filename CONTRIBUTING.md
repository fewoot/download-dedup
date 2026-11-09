# Contributing

感谢你愿意改进这个项目。这是一个单文件 Tampermonkey 用户脚本，没有构建步骤。

## 提交 Issue

请尽量包含：

1. 目标网站地址（可以只给域名）。
2. Tampermonkey 菜单 →“检查本页标题识别”的输出。
3. 实际看到的标题，以及你认为应该合并/拆分的两条标题。
4. 浏览器和 Tampermonkey 版本。

请不要粘贴账号、Cookie、下载站登录凭据或任何隐私信息。

## 提交 Pull Request

1. Fork 仓库并从 `main` 创建分支。
2. 保持用户脚本为单文件：`download-dedup.user.js`。
3. 不引入外部运行时依赖，不发送遥测或网络请求。
4. 本地运行语法检查：

   ```bash
   npm run check
   ```

5. 在 PR 描述里说明改动目的、影响的站点类型，以及测试过的标题样例。

## 代码约定

- 使用 2 个空格缩进，保持现有注释风格。
- 新增标题规则时，优先增加可读的正则和测试样例，不要在匹配函数里堆特殊判断。
- 涉及站点特化的规则，优先放进 `SITE_RULES.titleSelectors` / `excludeSelectors`，不要写死某个站点的私有结构。
