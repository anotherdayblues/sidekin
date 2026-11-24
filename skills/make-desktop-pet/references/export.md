# 验收与导出

每只新宠物默认带自己的睡觉动画。生图时附上本次制作已确认的主形象图 `references/canonical-base.png`，沿用本次 `prompts/rows/idle.md` 中的 `Identity` 和 `Style` 原文。睡觉动作使用以下两段提示词。

```text
State action: Quiet sleep sequence. The pet settles into a sleeping pose,
breathes gently while asleep, then wakes and returns to its starting pose.
Use only features already present in the attached canonical base.

State requirements:
- Frames 1–4: Start in the pet's normal resting pose. Settle into sleep
  with one small, continuous change of posture. If the pet has visible
  eyes, let them close as it settles.
- Frames 5–12: Hold that sleeping pose. Show one subtle breath through
  a small local movement that fits this pet's existing shape. Keep the
  rest of the pose still. Keep its position and scale steady across frames.
  Frame 12 should flow smoothly back into frame 5.
- Frames 13–16: Wake gently and return to the starting pose. Keep the
  change of posture as small and continuous as it was when falling asleep.
- Preserve the pet's existing anatomy and props throughout. Add no new
  body parts, props, symbols, or effects.
```

成品为 16 格透明横条，每格 192 × 208。三段同尺寸、同落脚点。连续看三轮呼吸和起身，确认接缝，再用 `export_pet.py export --sleep-strip 睡眠横条.png` 随基础包一起交付。导入后默认十分钟没碰宠物就睡，点它才醒。

先运行结构检查，然后看正常大小的实际动画。对于已生成的图集，可以直接用 `scripts/preview_atlas.py` 提取出播放预览；这一步不生成新角色。

```bash
python3 "$SKILL_DIR/scripts/preview_atlas.py" --atlas "$ATLAS" --output "$RUN_DIR/qa/final-preview"
python3 "$SKILL_DIR/scripts/hatch.py" measure_direction_continuity "$ATLAS" --json-out "$RUN_DIR/qa/look-continuity.json"
python3 "$SKILL_DIR/scripts/export_pet.py" review-template --atlas "$ATLAS" --output "$RUN_DIR/qa/final-review.json"
```

模板全部为待检查状态。Codex 或用户实际看过后，填写 `identity`、`transitions`、九个 `motions` 和十六个 `directions`。每项包含 `pass` 和具体 `note`；`reviewedBy` 记录真实检查者。必须确认四个主要方向明确、相邻方向顺序正确，动作之间无明显跳位、变形或比例突变。静态接触表用于看形象，GIF 用于看时间和衔接，两者配合。

```bash
python3 "$SKILL_DIR/scripts/export_pet.py" export \
  --atlas "$ATLAS" --review "$RUN_DIR/qa/final-review.json" \
  --id my-pet --name "小伙伴" --description "准备时写的那句性格介绍" \
  --sleep-strip "$RUN_DIR/sleep.png" \
  --revision 1 --chroma-key '#FF00FF' \
  --output /absolute/path/exports/my-pet-r1 --deliver
```

`--deliver` 在导出成功后把宠物包送进随伴的收件箱，并等随伴的回执。已经导出过的包可以单独再送一次：

```bash
python3 "$SKILL_DIR/scripts/export_pet.py" deliver --package /absolute/path/exports/my-pet-r1
```

色键必须取自实际生成任务。导出器会运行开源结构验证器，检查审阅记录与最终文件的 SHA-256 一致，并复制原样图集。新输出目录避免覆盖旧版本。

宠物包包括：

```text
pet.json             名称、稳定编号、修订版和行为配置
sleep.png            此宠物的入睡、呼吸与起身
spritesheet.webp     或 spritesheet.png，保留原格式
```

同级生成的 ZIP 用来分享和备份，也可以在 Pet Studio 里点 ＋ 手动导入。检查记录另存于工作目录，原始照片留在制作项目。

交付完成后，顺便告诉用户：如果对某个动作不满意，可以直接对 AI 说「按原技能的要求，只重做 ×× 动作，其余都不变」（改整体长相/主形象除外，改长相需回到主形象重新生成全部动作）。

## 调整随机行为

```bash
python3 "$SKILL_DIR/scripts/behavior.py" /absolute/path/package/pet.json \
  --min 30 --max 90 --weight waving=3 --weight jumping=1 --weight review=2
```

间隔含义：每次动作结束后，等待指定范围内随机选定的一段时间，再按权重选动作。权重是相对比例，0 表示不随机触发。同一动作有替代选项时避免连续重复。左右跑用于拖动，不进入普通随机池。默认悬停等待，点击打开管理窗口。支持 `--quiet`、`--click`、`--double-click`、`--no-gaze`；自定义点击属于用户显式选择的扩展。

修改后重新打 ZIP 或直接导入文件夹。播放器的“恢复宠物默认行为”可清除旧的个人覆盖；用户手动调过的设置默认继续保留。
