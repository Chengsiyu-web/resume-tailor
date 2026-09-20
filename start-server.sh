#!/bin/bash
# LaunchAgent 启动脚本：nvm 的 node 不在系统 PATH，这里显式加载
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
cd "$(dirname "$0")"
exec ./node_modules/.bin/tsx src/server.ts
