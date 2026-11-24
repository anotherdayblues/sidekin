# 来源与改造范围

本 Skill 的说明、任务衔接、原生透明适配、跨状态配准、动作检查和本地导出代码在 Pet Studio 中实现。

`vendor/hatch-pet/SKILL.md` 是本机 Codex 安装的开源 hatch-pet Skill 说明原文（Apache-2.0，许可证与 `vendor/hatch-pet/LICENSE` 相同），与下列脚本属于同一版本，原样保留；本 Skill 的 `SKILL.md` 列出对它的改动。

`vendor/hatch-pet` 的脚本和参考文件来自 [MakerCore/hatch-pet](https://github.com/MakerCore/hatch-pet)，固定提交 `313a8c92f4847e88154d1e1f34e4ba1c124fbf3f`，使用 Apache-2.0 许可证。原文件保持独立，适配逻辑放在本 Skill 的 `scripts/hatch.py`，包括 idle/0 中立帧、透明素材处理、共享比例提取。

本 Skill 在 Codex 中运行，通过当前安装的图像生成能力制作原创素材；导出本地宠物包，供独立播放器运行。它不是 OpenAI 官方插件，也不包含本机专有 Work Pets 插件的源码副本。
