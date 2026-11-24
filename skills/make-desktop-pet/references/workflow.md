# 制作流程

本文按官方 Hatch Pet 的顺序列出命令，只写本 Skill 不同的地方。每一步的检查标准、失败处理和子代理分工，按 [官方说明索引](official-index.md) 读对应的那一段，不要整份读官方说明。

```bash
HATCH="python3 $SKILL_DIR/scripts/hatch.py"
PROJECT="python3 $SKILL_DIR/scripts/project.py"
```

## 1. 准备

```bash
$PROJECT prepare --run "$RUN_DIR" --name "栗子" --id lizi \
  --description "安静的橘白小猫，喜欢陪在旁边，看到新东西会好奇地凑过去。" \
  --notes "只写长相：体型、脸、花纹、颜色、材质、道具和避免项" \
  --style auto --reference /absolute/path/photo.jpg
$PROJECT status --run "$RUN_DIR"
```

`--reference` 可以重复传入。`--id` 是以后更新同一只宠物时使用的稳定编号。`prepare` 只准备任务、提示词、排版参考和色键，不生成图片。

`status` 的 `ready` 列出可以开始的任务。每个任务的提示词、参考图和输出位置在 `imagegen-jobs.json` 里。

## 2. 主形象

按官方方式用 `$imagegen` 生成 `base`，复制到 `decoded/base.png`。先确认是自然站姿（四肢/落脚点与关键花纹清楚，不照搬参考照片里的坐趴或蜷缩姿势），再缩小到正常桌宠大小给用户看。用户认可后：

```bash
$PROJECT accept --run "$RUN_DIR" --job base --reviewer user --note "用户确认的具体特征"
```

这一步会写入 `references/canonical-base.png`，后面每个任务都用它作为身份参考。

## 3. 标准动作

先做 `idle` 和 `running-right`，确认形象和步态没问题，再做其他行；`running-left` 只有在镜像不改变身份时才用官方脚本派生。每行生成后立刻检查：

```bash
$HATCH extract_strip_frames --decoded-dir "$RUN_DIR/decoded" \
  --output-dir "$RUN_DIR/qa/rows/<state>/frames" --states <state> --method auto
$HATCH inspect_frames --frames-root "$RUN_DIR/qa/rows/<state>/frames" \
  --json-out "$RUN_DIR/qa/rows/<state>/review.json" --states <state> --require-components
$PROJECT accept --run "$RUN_DIR" --job <state> --reviewer codex --note "实际看到的动作要点"
```

九行都通过后，提取全部帧，**先统一配准**，再拼图：

```bash
$HATCH extract_strip_frames --decoded-dir "$RUN_DIR/decoded" --output-dir "$RUN_DIR/frames" --states all --method auto
$HATCH inspect_frames --frames-root "$RUN_DIR/frames" --json-out "$RUN_DIR/qa/review.json" --require-components
python3 "$SKILL_DIR/scripts/register_states.py" --frames "$RUN_DIR/frames" --output "$RUN_DIR/registered-frames"
$HATCH compose_atlas --frames-root "$RUN_DIR/registered-frames" \
  --output "$RUN_DIR/final/spritesheet.png" --webp-output "$RUN_DIR/final/spritesheet.webp"
$HATCH make_contact_sheet "$RUN_DIR/final/spritesheet.webp" --output "$RUN_DIR/qa/contact-sheet.png"
$HATCH render_animation_previews --frames-root "$RUN_DIR/registered-frames" --output-dir "$RUN_DIR/qa/previews"
```

配准前，先看各行第一帧是不是同一只宠物的正常站姿。配准对每一行使用同一个变换，保留跳跃的上下位移。看 GIF，不只看静态接触表。

## 4. 注视方向

完全按官方顺序：写 `qa/look-mechanics.md` → 四个主方向 → 第 9 行（立即配准并检查）→ 第 10 行 → 拼装 v2 图集 → 去色边一次 → 验证 → 方向检查表 → 盲测 → 连续性。`--neutral-cell` 用 `"$RUN_DIR/registered-frames/idle/00.png"`，`--base-atlas` 用上一步的 `final/spritesheet.webp`。

`000` 表示向上看，不是正面。十六个方向从上开始，顺时针每 22.5 度一个。每个方向在 `qa/direction-semantics.json` 里写清看到的依据。

## 5. 导出

按 [验收与导出](export.md) 生成预览、填写审阅记录、导出宠物包。色键用 `pet_request.json` 里的 `chroma_key.hex`。

## 修改

```bash
$PROJECT repair --run "$RUN_DIR" --job <state> --reason "用户说尾巴花纹不对"
$PROJECT status --run "$RUN_DIR"
```

旧素材会存到 `history/`。修改主形象时，所有依赖它的任务都重新进入待办；只改一个动作时，其他已通过的行保持不变。
