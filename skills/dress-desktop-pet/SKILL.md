---
name: dress-desktop-pet
description: "给已经在随伴（Pet Studio）桌面上的宠物做一套新衣服（衣柜穿搭），不破坏原有形象、睡眠动画和学会的动作。用户说“给栗子做套睡衣”“给我的猫做一套卫衣”“做套夏日穿搭”“帮它加套万圣节装扮”时使用。做新宠物用 $make-desktop-pet，教新动作或改动作规则用 $teach-desktop-pet。Author a new wardrobe outfit for an existing Pet Studio desktop pet using dual-reference anchor-locked animation authoring."
---

# 给宠物做新衣服

为已安装在随伴里的宠物制作一套完整的换装图集，并通过增量收件箱安全加进它的衣柜。

保持同一只宠物、1:1 锁定原宠尺寸与落脚点、不拉伸变形、不碰原宠基础图集、睡眠横条（`sleepStrip`）和所有已学会动作。

所有路径相对本 Skill；`SKILL_DIR` 指本目录。脚本只需要 Python 3.9+ 和 Pillow。

```bash
DRESS="python3 $SKILL_DIR/scripts/dress.py"
```

## 先确认用对了 Skill

| 用户想要 | 用什么 |
| --- | --- |
| 给已有宠物加一套新衣服（睡衣、卫衣、节日装等） | 本 Skill |
| 重做某套已做衣服的个别动作行或整套重画 | 本 Skill（沿用原工作目录 `repair`） |
| 宠物衣柜里已经有这套衣服，只想手动换装或删除不要的衣服 | 不用 Skill。在随伴首页点右上角「衣柜」胶囊即可切换或删除 |
| 给已有宠物教新动作，或设置双击/随机/定时播放动作 | `$teach-desktop-pet` |
| 做一只全新的宠物，或彻底重做原宠的本体长相 | `$make-desktop-pet` |
| 给软件加新功能（界面、聊天、气泡、扩展能力） | 不用 Skill。这是改软件，去项目里读 `docs/扩展开发.md` |

## 生图工具

- **在 Codex 里**：用 `$imagegen`。
- **在别的 AI 里**：先确认你使用的生图工具名称和传图方式，把本文和参考文件里的 `$imagegen` 换成你的工具，其余规则不变。
- **生图必须支持附带至少两张参考图。** 新衣服动作行必须同时参考「用户确认的新衣服造型图」和「原宠物该行的成品动作横条」，只靠文字无法对齐同一角色和步态。做不到就直接告诉用户缺什么。

## 决定留给用户

新衣服定妆、最终送达后的切换与固定穿搭，都由用户自己决定。

- 定妆图（`base`）**必须先给用户看并获得确认**，才能继续生成后续动作行（脚本会硬性拦截未确认的动作行）。
- 不要用 computer use、AppleScript、模拟点击或任何别的方式，去点随伴里的按钮（如切换衣柜、删除宠物、接受草稿等）。
- 不要直接修改随伴数据目录（`PET_STUDIO_DATA`）里的文件。新衣服只能通过 `$DRESS deliver` 投递进收件箱。

## 省着用上下文

- **按阶段读参考文档**：开始生图前读 [双参考图提示词规范](references/prompts.md)。
- **查宠物只用 `$DRESS pets`**，不要去翻随伴数据目录。
- **查进度只用 `$DRESS status`**，每次最多推进 `ready` 里列出的 3 个动作行，不要整份读 `outfit-state.json`。
- **脚本只运行，不读源码**；参数随时用 `$DRESS <子命令> --help` 查。
- **生图交给子代理（若有）**：每个动作行回传「图片路径 + 一句检查结论」，主对话重点看 `qa/<job>-sheet.png`、`qa/<job>.gif` 和最终 `qa/compare-base-vs-outfit.png`。

## 1. 看清已有宠物和衣柜

```bash
$DRESS pets
```

确认目标宠物的编号（`petId`）、图集规格（V1 `1536×1872` 或 V2 `1536×2288`）和已有服装。用户没指定哪只且随伴里不止一只时，先问一句。

## 2. 初始化换装工作目录

在独立空白目录（不能在技能目录、随伴数据目录或源码目录里）初始化：

```bash
$DRESS init --pet lizi --outfit pajamas --label "睡衣" \
  --desc "soft cream-and-lavender striped cotton pajamas with a tiny matching nightcap" \
  --dir /tmp/dress-lizi-pajamas
```

`init` 会自动完成四件事：
1. 从原宠物图集切出 `refs/base-idle-0.png` 和全部动作行的成品参考条 `refs/rows/*.png`（V2 含 `gaze-1`、`gaze-2`）。若目标宠物带睡眠动画（`sleepStrip`），自动切出 `refs/rows/sleep.png`（16 帧 3072×208）并加入 `sleep` 任务（不想做睡眠动画可加 `--no-sleep`；无睡眠动画的宠物自动跳过）。
2. 计算并锁死 `refs/anchor.json`，记录原宠每一行、每一帧的精确身高与落脚点——后续所有帧 1:1 锚定原宠，切衣服零跳动、零缩放漂移、绝不拉扯变形。
3. 根据服装描述自动避开冲突颜色，选定安全的纯色抠图背景（色键）。
4. 生成可断点续跑的 `outfit-state.json` 和双参考提示词 `jobs/*.txt`。

### 只给已有衣服补做睡眠动画（`--only-sleep`）

若某套衣服已装进衣柜（如 `moon-pajamas`），只想补配同款 16 帧睡眠横条、不重做 11 行图集：

```bash
$DRESS init --pet lizi --outfit moon-pajamas --only-sleep --dir /tmp/sleep-moon-pajamas
```

脚本直接从已装衣服图集提取 `approved/base.png`，从原宠提取 `refs/rows/sleep.png`，只排队 `sleep` 一项任务；`accept --job sleep` → `compose` → `deliver` 仅增量补丁 `outfits/<slug>-sleep.png`，原衣服图集 100% 不动。

## 3. 先出新衣服定妆图，等用户确认

1. 读 `jobs/base.txt`，附上 `refs/base-idle-0-2x.png`（或 `refs/base-idle-0.png`）用 `$imagegen` 生成新衣服定妆图。
2. 按正常桌宠大小给用户看，确认「还是同一只宠物、比例自然没变形、衣服细节符合预期」。
3. 用户认可后登记：
   ```bash
   $DRESS accept --dir /tmp/dress-lizi-pajamas --job base --image /path/to/base.png \
     --reviewer user --note "用户确认睡衣条纹与小睡帽"
   ```

## 4. 双参考生成动作行与注视行

运行 `$DRESS status --dir /tmp/dress-lizi-pajamas`，按 `ready`（每次最多 3 个）推进。读 [双参考图提示词规范](references/prompts.md)。

每个动作行（9 行标准动作 + V2 的 `gaze-1`、`gaze-2`）：
1. 读 `jobs/<job>.txt`，**同时附上两张参考图**：`approved/base.png`（确认的新衣服外观）+ `refs/rows/<job>.png`（原宠物自己的该行成品横条）。
2. 生图后立即执行 `accept`：
   ```bash
   $DRESS accept --dir /tmp/dress-lizi-pajamas --job idle --image /path/to/idle.png \
     --reviewer agent --note "呼吸起伏与原宠一致，睡衣花纹稳定"
   ```
   脚本会自动备份原图、记录 SHA-256、基于边界连通抠图与外缘去色边、按 `refs/anchor.json` 1:1 锚定配准，并输出对比条 `qa/<job>-sheet.png` 和预览动图 `qa/<job>.gif`。
3. 必须检查 `qa/<job>-sheet.png` 和 `qa/<job>.gif`；某行不满意就局部返工，不影响其他已通过的行：
   ```bash
   $DRESS repair --dir /tmp/dress-lizi-pajamas --job waving --reason "左手袖口颜色漂移"
   ```

## 5. 拼装校验与对比验收

全部动作行通过后拼装最终服装图集：

```bash
$DRESS compose --dir /tmp/dress-lizi-pajamas
```

脚本会生成 `outfits/<slug>.webp`（匹配原宠 V1/V2 尺寸，V2 自动同步 `(0, 6)` 中立格）、执行确定性尺寸/透明度/非空帧/锚点对齐校验，并渲染原宠 vs 新衣服并排对比图 `qa/compare-base-vs-outfit.png`。务必打开对比图确认整体一致、无大小漂移或残留毛边。

## 6. 增量交付进随伴

```bash
$DRESS deliver --dir /tmp/dress-lizi-pajamas
```

脚本会把增量清单 `outfit.json` 与 `outfits/<slug>.webp` 原子送入随伴收件箱。原宠的基础图集、睡眠动画和所有学会的动作都会 100% 原封不动保留。

交付完成后告诉用户：
1. 随伴在运行时会自动更新衣柜并弹出主窗口；未运行时已放进收件箱，下次打开自动出现。
2. 在随伴首页点右上角「衣柜」即可试穿、切换或删除服装（桌面宠物右键「换装」也能一键切换）。
3. 以后若对某一行动作不满意，直接说「把这套衣服的 ×× 动作重画一下」，沿用原工作目录局部 `repair` 即可。
