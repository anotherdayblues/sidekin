# 文件模块来源

拖出采用 CrabNebula drag-rs 的 drag crate 2.1.1，Cargo 固定版本。原生启动与结束回调直接复用该库。早期插件 JS 绑定留在 vendor/drag-rs 作参考。

文件堆采用 Phoenix124/droper 提交 d3cf56d01c83a1c04e751e9adf2eccc295f6338c。shelfStore 仅将 Node randomUUID 改为浏览器 crypto.randomUUID。partial remove、dragOut、rangeSelection 和 previewBounds 的逻辑保留。许可见 vendor/droper/LICENSE。

类型图标原样取自 Material Icon Theme，提交 ced21b9b5241c1efa502a8c46ec7363a690a7058。许可见 vendor/material-icons/LICENSE。目录由系统 metadata 确认，其余类型按扩展名映射。

Mac 原生监视采用 Droper 拖拽粘贴板变化的做法。Windows 采用 Holdem 的 GetAsyncKeyState/GetCursorPos 做法。接收文件路径由 Tauri 自带 DragDropEvent 提供。

拖出手势参考 Holdem。源码见同一提交的 [PopupWindow.tsx](https://github.com/iamzubin/holdem/blob/35644fe0f1c4eeda4c9bd4deb02bb7b8b4b6b734/app/src/PopupWindow.tsx) 与 [fileUtils.ts](https://github.com/iamzubin/holdem/blob/35644fe0f1c4eeda4c9bd4deb02bb7b8b4b6b734/app/src/lib/fileUtils.ts)。从按下与移动手势直接启动原生拖动。准备期间跟踪松手，避免浏览器拖动冲突。取消动画选项沿用 [drag_ops.rs](https://github.com/iamzubin/holdem/blob/35644fe0f1c4eeda4c9bd4deb02bb7b8b4b6b734/app/src-tauri/src/commands/drag_ops.rs) 的 skip_animatation_on_cancel_or_failure=true。许可见 vendor/holdem/LICENSE。

新增连接代码负责把这些能力接进原随伴的窗口、尺寸设置、轮廓和位置保存。实际入口为原 apps/desktop 应用，完整副本的隔离信息见 source/HANDOFF.md。
