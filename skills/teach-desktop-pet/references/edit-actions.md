# 修改现有动作

沿用新本领的收件箱和草稿确认流程。新版动作只有在用户接受后才生效。用户可以在“旧版动作”里选用以前的画面。

## 开放范围

只重画学会的动作：做一次的和持续的都可以，持续的保留原来的循环段（脚本自动沿用）。基础动作暂不开放重画，睡觉保持原样。这是固定范围。

## 先取当前参考图

沿用复制指令中的 `PET_STUDIO_DATA`，按宠物编号和动作编号开始：

```bash
python3 "$SKILL_DIR/scripts/teach.py" new --pet <宠物编号> --replace <动作编号> \
  --dir <独立制作目录> --summary "修改某个动作：用户的改法"
```

脚本会先检查开放范围，再导出：

- `references/current-action.png`：当前已接受的完整动作横条。改过的动作导出已接受的新版。
- `references/idle-2x.png`：待机大小和落脚点参考。
- `references/identity.png`：原角色身份参考。
- `replacement.json`：原动作名称、帧数、播放节奏和参考版本。

读取 `replacement.json`，保留动作编号、名称、帧数、播放节奏和循环段。

根据用户的改法和当前动作写逐帧描述。沿用当前角色的长相、比例和画风。按角色已有的身体结构完成动作。动作要求不写死物种或花色。保留原用途、进入和结束姿势、循环方式；专心工作仍是持续工作循环。

专心工作默认启用安静学习实验：身体基本不动，用小幅、清楚的操作动作表现学习。想关掉这项提示词实验时，在 `prompt` 加 `--work-row original`。


## 生成与交付

```bash
python3 "$SKILL_DIR/scripts/teach.py" prompt --dir <目录> --name <原动作编号> \
  --label <原名称> --frames <原帧数> --motion "逐帧描述用户要求的改法" --props "所需道具"
```

用生图工具按 `prompt_file` 生成，必须把输出中全部 `input_images` 真正附入请求，不能只把图片路径写在文字里。原生图提示词有的话可作补充，当前动作和身份参考图是依据。

```bash
python3 "$SKILL_DIR/scripts/teach.py" add-action --dir <目录> --name <原动作编号> \
  --label <原名称> --strip <生成图>
```

脚本按原动作第一帧统一配准，自动沿用原播放节奏，并生成 `qa/<编号>-before-after.gif`。左边是修改前，右边是修改后。同时检查普通 GIF 和逐帧图：长相、比例、动作意思、衔接、画面边缘和循环。

修改包只包含本次动作，不附带规则变更。检查并用 `stage` 投递，告诉用户在随伴里试播、接受替换或暂不使用；动作都会保存在“旧版动作”。涉及接受、放弃和回退的按钮，由用户操作。

```bash
python3 "$SKILL_DIR/scripts/teach.py" check --dir <目录>
python3 "$SKILL_DIR/scripts/teach.py" stage --dir <目录>
```

如果脚本或随伴提示参考版本已变化，重新导出当前版本再制作，避免覆盖用户后来接受的改动。
