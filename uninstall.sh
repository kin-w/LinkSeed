#!/usr/bin/env bash
# ============================================================
# 链种工坊 LinkSeed · 一键卸载脚本
# 仓库：https://github.com/kin-w/LinkSeed
# 用法：bash <(curl -fsSL https://raw.githubusercontent.com/kin-w/LinkSeed/main/uninstall.sh) -y
# ============================================================
set -euo pipefail

CONTAINER="linkseed"
DATA_DIR="/opt/linkseed/data"
REMOVE_IMAGE=0
REMOVE_DATA=0

C_OK="\033[32m"; C_WARN="\033[33m"; C_ERR="\033[31m"; C_DIM="\033[2m"; C_END="\033[0m"

info()  { printf "${C_OK}[信息]${C_END} %s\n" "$*"; }
warn()  { printf "${C_WARN}[提示]${C_END} %s\n" "$*"; }
error() { printf "${C_ERR}[错误]${C_END} %s\n" "$*" >&2; }
dim()   { printf "${C_DIM}       %s${C_END}\n" "$*"; }

usage() {
  cat <<EOF
链种工坊 LinkSeed 一键卸载脚本

用法：
  bash uninstall.sh [选项]

默认行为：停止并删除容器、删除 compose 文件，保留数据目录与镜像。

选项：
  -n <名称>    容器名称，默认 linkseed
  -c <目录>    数据存放目录，默认 /opt/linkseed/data
  -d           同时删除数据目录（上传文件、历史、设置都会丢失）
  -i           同时删除 Docker 镜像
  -y           跳过确认，直接执行
  -h           显示帮助

示例：
  bash uninstall.sh            # 只卸载容器
  bash uninstall.sh -y -d      # 连数据一起删除，不再询问
  bash <(curl -fsSL https://raw.githubusercontent.com/kin-w/LinkSeed/main/uninstall.sh) -y -d -i
EOF
}

while getopts ":n:c:diyh" opt; do
  case "$opt" in
    n) CONTAINER="$OPTARG" ;;
    c) DATA_DIR="$OPTARG" ;;
    d) REMOVE_DATA=1 ;;
    i) REMOVE_IMAGE=1 ;;
    y) SKIP_CONFIRM=1 ;;
    h) usage; exit 0 ;;
    *) error "未知参数：-$OPTARG"; usage; exit 1 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  if [ -f "$0" ]; then
    warn "需要 root 权限，尝试使用 sudo 重新执行"
    exec sudo bash "$0" "$@"
  fi
  error "请使用 root 用户运行：curl -fsSL <脚本地址> | sudo bash -s -- -y"
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  error "未检测到 Docker，无需卸载"
  exit 1
fi

case "$DATA_DIR" in
  /*) ;;
  *) error "-c 必须是绝对路径"; exit 1 ;;
esac

COMPOSE_FILE="$(dirname "$DATA_DIR")/docker-compose.yml"
IMAGE=""
if [ -f "$COMPOSE_FILE" ]; then
  IMAGE=$(awk '/^[[:space:]]*image:/{print $2; exit}' "$COMPOSE_FILE" || true)
fi

echo
info "将执行以下操作："
dim "容器名称：${CONTAINER}"
dim "compose：${COMPOSE_FILE}"
if [ "$REMOVE_DATA" = "1" ]; then
  dim "数据目录：${DATA_DIR}（将删除）"
else
  dim "数据目录：${DATA_DIR}（保留）"
fi
if [ "$REMOVE_IMAGE" = "1" ]; then
  dim "镜像：${IMAGE:-<未找到，跳过>}（将删除）"
else
  dim "镜像：保留"
fi
echo

if [ "${SKIP_CONFIRM:-0}" != "1" ]; then
  if [ -t 0 ]; then
    printf "确认继续？[y/N] "
    read -r ANSWER
    case "$ANSWER" in
      y|Y|yes|YES) ;;
      *) info "已取消"; exit 0 ;;
    esac
  else
    warn "非交互环境，请加 -y 确认执行"
    exit 1
  fi
fi

# ---------- 停止并删除容器 ----------
if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  docker rm -f "$CONTAINER" >/dev/null
  info "容器 $CONTAINER 已删除"
else
  warn "未找到容器 $CONTAINER，跳过"
fi

# ---------- 删除 compose ----------
if [ -f "$COMPOSE_FILE" ]; then
  rm -f "$COMPOSE_FILE"
  info "已删除 $COMPOSE_FILE"
fi

# ---------- 删除数据 ----------
if [ "$REMOVE_DATA" = "1" ]; then
  if [ -d "$DATA_DIR" ]; then
    rm -rf "$DATA_DIR"
    info "已删除数据目录 $DATA_DIR"
  else
    warn "数据目录不存在，跳过"
  fi
  PARENT_DIR="$(dirname "$DATA_DIR")"
  if [ -d "$PARENT_DIR" ] && [ -z "$(ls -A "$PARENT_DIR")" ]; then
    rmdir "$PARENT_DIR" 2>/dev/null || true
  fi
else
  warn "数据目录已保留：$DATA_DIR"
  dim "如需彻底清理：rm -rf ${DATA_DIR}"
fi

# ---------- 删除镜像 ----------
if [ "$REMOVE_IMAGE" = "1" ]; then
  if [ -n "$IMAGE" ] && docker image inspect "$IMAGE" >/dev/null 2>&1; then
    docker rmi "$IMAGE" >/dev/null
    info "镜像 $IMAGE 已删除"
  else
    warn "镜像不存在或未识别，跳过"
  fi
fi

echo
info "卸载完成"
dim "Docker 本身未卸载；如需卸载：apt remove docker-ce 或参考官方文档"
echo
