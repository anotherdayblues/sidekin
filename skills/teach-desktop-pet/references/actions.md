# 新动作制作

新动作是一条横向的帧序列，每帧 192 × 208，播放时和基础动作在同一个格子里。`teach.py` 负责去背景、统一大小和对齐，生图只负责把姿势画对。

## 写 `--motion`

用英文逐帧写，帧号对应位置。规则：

- **第一帧和最后一帧都是平时的待机站姿**，跟 `idle-2x.png` 一样。脚本靠第一帧对齐大小和落脚点，首尾回到待机才能和其他动作自然衔接。可循环的拖动动作也照此处理，首尾相接。
- 一般 6–10 帧。动作越复杂，帧越多；超过 12 帧时，考虑拆成两个动作，用规则串起来。“抱枕头走出来 → 打哈欠 → 回去”就是三个动作。
- 写清楚每一帧身体哪部分怎么动，而不是写情绪。比如写 “3: front paws raised above head, back arched, mouth wide open”，不要写 “3: very sleepy”。
- 动作幅度留在格子里：不要大跳跃，不要走出画面，不要躺成很长的一条。躺下或伸懒腰这类横向姿势，身体长度不要超过站立时的 1.4 倍。
- 道具只在需要时写进 `--props`，并说明它被拿着、贴着或戴在身上。

例子（伸懒腰，8 帧）：

```text
1: calm idle stand, facing the viewer.
2: lowers chest toward the ground, front legs start reaching forward.
3: front legs stretched forward, chest low, rear raised, tail up.
4: deepest stretch, eyes squeezed shut, mouth slightly open.
5: shifts weight forward, back legs stretched behind.
6: rises back up, small shake of the head.
7: almost standing, ears relaxed.
8: calm idle stand, same as frame 1.
```

## 生成

- 用 `$imagegen` 生成，附上 `prompt` 命令列出的全部参考图：待机帧、身份参考、排版参考。不能只靠文字生成。
- 一张图只画一个动作。不要让它一次生成多个动作，也不要拼图。
- 背景默认是品红色 `#FF00FF`。宠物或道具本身是品红、粉紫色时，用 `--chroma "#00FF00"` 等对比色重新生成提示词。生成工具能直接输出透明背景时，脚本会保留透明通道。

## 处理与检查

`add-action` 的处理顺序：

1. 去掉纯色背景。边缘像素按背景色反算，避免留下色边。
2. 按透明列找到每个姿势。找到的数量不等于帧数就报错；这时重新生成，让姿势之间留出空隙。不要轻易加 `--equal-slots`。
3. 以第一帧为准，把宠物缩放到和待机帧一样高，底部对齐待机的落脚线。其余帧用同一比例和同一地面，保留动作里的上下左右位移。
4. 有帧超出 192 × 208 时报错。用 `--fit` 可以整体缩小，但宠物会比平时小。优先减小动作幅度后重新生成。

帧时长默认每帧 140 毫秒，最后一帧 220 毫秒。需要节奏时用 `--durations 140,140,200,400,...`，例如打哈欠张到最大时停久一点。

检查 `qa/<名字>.gif` 时逐项确认：

| 检查 | 不合格的样子 |
| --- | --- |
| 同一只宠物 | 花纹、颜色、脸型、比例变了 |
| 动作意思 | 看不出是在做用户说的事 |
| 衔接 | 从待机进入或回到待机时，位置或大小跳一下 |
| 连续 | 中间某帧突然变大变小、闪一下、方向反了 |
| 干净 | 残留背景色块、地面、阴影、文字、飘在空中的符号 |
