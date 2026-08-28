# oh-my-pi 中文版

这是 [oh-my-pi](https://github.com/can1357/oh-my-pi) 的本地简体中文界面版本。

## 已中文化

- 欢迎页：提示、最近会话、LSP 服务器和快捷键说明
- 设置页：栏目、分组、设置名称、说明、选项和警告
- 首次启动向导：符号、主题、输入框样式、默认模型和保存提示
- 暂停界面：暂停状态、恢复说明和运行状态提示

命令名（例如 `/settings`、`/model`）、快捷键、模型名、文件路径、代码、工具输出和协议字段保持原样，保证原有工作方式不变。未知的第三方扩展文字也会保留英文，不会显示为空白。

## 构建和运行

中文版本已经构建完成。从本目录运行：

```sh
./omp-cn
```

需要重新构建时，先确保已安装 Bun 和项目依赖，然后运行：

```sh
bun --cwd=packages/coding-agent run gen:tool-views
bun --cwd=packages/coding-agent run gen:bundle
```

可用 `./omp-cn --version` 确认启动器是否正常。要重新打开首次设置向导，可运行 `./omp-cn setup`。

启动器会使用中文构建产物和你本机已安装的 oh-my-pi 运行组件。本地中文版本不会替换原来的 `omp`；需要中文界面时进入此目录运行 `./omp-cn`。
