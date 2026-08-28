#!/bin/bash
# oh-my-pi 中文版一键安装脚本
# 用法：
#   bash install-cn.sh
# 可选环境变量：
#   OMP_CN_INSTALL_DIR  安装位置（默认 ~/.omp/oh-my-pi）
#   OMP_BIN_DIR         omp 命令存放位置（默认 ~/.bun/bin）
set -euo pipefail

REPO="https://github.com/hi5548/oh-my-pi.git"
INSTALL_DIR="${OMP_CN_INSTALL_DIR:-$HOME/.omp/oh-my-pi}"
BIN_DIR="${OMP_BIN_DIR:-$HOME/.bun/bin}"

say(){ printf '\033[1;32m==> %s\033[0m\n' "$1"; }
fail(){ printf '\033[1;31m安装失败：%s\033[0m\n' "$1" >&2; exit 1; }

# 1. Bun 运行环境
if ! command -v bun >/dev/null 2>&1; then
  say "未检测到 Bun，正在安装..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  command -v bun >/dev/null 2>&1 || fail "Bun 安装后仍不可用，请关闭终端重新打开再试"
fi
say "Bun 就绪：$(bun --version)"

# 2. 下载/更新源码
if [ -d "$INSTALL_DIR/.git" ]; then
  say "已有安装目录，更新代码..."
  git -C "$INSTALL_DIR" pull --ff-only || say "警告：代码更新失败，继续用现有代码构建"
else
  say "下载中文版源码到 $INSTALL_DIR ..."
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 "$REPO" "$INSTALL_DIR" || fail "源码下载失败，请检查网络后重试"
fi

cd "$INSTALL_DIR"

# 3. 依赖（默认源失败自动换国内镜像）
say "安装依赖（首次需要几分钟，请耐心等待）..."
if ! bun install; then
  say "默认下载源不可用，改用国内镜像重试..."
  NPM_CONFIG_REGISTRY=https://registry.npmmirror.com bun install || fail "依赖安装失败"
fi

# 3.5 平台加速引擎（从源码安装时需要放置对应平台的预编译文件）
NATIVE_DIR="packages/natives/native"
mkdir -p "$NATIVE_DIR"
if ! ls "$NATIVE_DIR"/*.node >/dev/null 2>&1; then
  say "下载平台加速引擎..."
  NATIVE_VER="$(grep -m1 '"version"' packages/natives/package.json | sed 's/.*: "//;s/".*//')"
  PLATFORM="$(bun -e 'console.log(process.platform+"-"+process.arch)')"
  PKG="@oh-my-pi/pi-natives-${PLATFORM}"
  TGZ="pi-natives-${PLATFORM}-${NATIVE_VER}.tgz"
  EXTRACT_DIR="$(mktemp -d)"
  FETCHED=false
  for REG in "https://registry.npmjs.org" "https://registry.npmmirror.com"; do
    if curl -fsSL "$REG/$PKG/-/$TGZ" -o "$EXTRACT_DIR/$TGZ" 2>/dev/null; then FETCHED=true; break; fi
  done
  [ "$FETCHED" = true ] || fail "加速引擎下载失败（$PKG@$NATIVE_VER）"
  tar -xzf "$EXTRACT_DIR/$TGZ" -C "$EXTRACT_DIR"
  cp "$EXTRACT_DIR/package/pi_natives.${PLATFORM}.node" "$NATIVE_DIR/" || fail "加速引擎文件缺失"
  rm -rf "$EXTRACT_DIR"
fi

# 4. 构建
say "构建中文版程序..."
bun --cwd=packages/coding-agent run gen:tool-views >/dev/null
bun --cwd=packages/coding-agent run gen:bundle >/dev/null
[ -f packages/coding-agent/dist/cli.js ] || fail "构建产物缺失"

# 5. 创建 omp 命令
say "创建 omp 命令..."
mkdir -p "$BIN_DIR"
printf '#!/bin/bash\nset -euo pipefail\nexec bun "%s/packages/coding-agent/dist/cli.js" "$@"\n' "$INSTALL_DIR" > "$BIN_DIR/omp"
chmod +x "$BIN_DIR/omp"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "提示：$BIN_DIR 不在 PATH 中，可将它加入 PATH 后使用 omp 命令" ;;
esac

# 6. 验证
say "验证安装..."
"$BIN_DIR/omp" --version
printf '\n\033[1;32m安装完成！在任意位置输入 omp 即可使用中文版。\033[0m\n'
