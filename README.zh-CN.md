# oh-my-pi 中文版

这是 [oh-my-pi](https://github.com/can1357/oh-my-pi) 的本地简体中文界面版本。

## 一键安装

需要 macOS 或 Linux。在终端运行：

```sh
curl -fsSL https://raw.githubusercontent.com/hi5548/oh-my-pi/main/install-cn.sh | bash
```

如果上面的地址访问不畅，也可以手动下载后运行：

```sh
git clone https://github.com/hi5548/oh-my-pi.git
cd oh-my-pi
bash install-cn.sh
```

脚本会自动完成：安装 Bun 运行环境（如缺失）→ 下载源码 → 安装依赖（默认下载源不可用时自动改用国内镜像）→ 构建中文版 → 创建 `omp` 命令 → 验证安装。

安装完成后，在任意位置输入 `omp` 即可使用中文版。

## 已中文化

- 模型选择界面与 `/models` 管理页：模型详情、角色、备用模型链、服务商状态与全部操作提示
- `/agents` 代理管理页、顾问（advisor）配置页
- 斜杠命令介绍与实时状态（输入 `/` 弹出的全部命令介绍）
- CLI 帮助：命令介绍、环境变量说明、工具说明
- 设置页、欢迎页、首次启动向导、暂停界面、OAuth 登录等
- 通用弹窗：历史搜索、会话移动、扩展控制中心等

命令名（例如 `/settings`、`/model`）、快捷键、模型名、服务商名、文件路径、代码、工具输出和协议字段保持原样，保证原有工作方式不变。

## 更新

官方上游更新后，需要重新同步代码、补翻新增文案并重新构建。建议联系本仓库维护者处理，不建议自行覆盖安装官方英文版。

## 手动构建（开发者）

```sh
bun install
bun --cwd=packages/coding-agent run gen:tool-views
bun --cwd=packages/coding-agent run gen:bundle
./omp-cn
```
