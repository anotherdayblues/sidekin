# “专心工作”行的通用电脑版提示词（安静学习实验）

本版已用栗子试画，将这份通用写法接入制作流程。只调整 `running` 的动作描述和要求，保留原模板的身份、画风、排版、衔接和去背景要求。

- **原始动作保留：** `vendor/hatch-pet/scripts/prepare_pet_run.py` 中的原版保持原样。
- **旧草稿保留：** 见 [最初的电脑版草稿](work-row-laptop-original.md)，可按需回退。
- **实验开关：** 新制作默认启用。`prepare --work-row original` 用原版；`repair --job running --work-row original` 可切回。已安装宠物继续用当前动作。
- **参考图必须传：** 每次附上当前宠物的主形象图和排版参考。局部重做时，再附上该宠物已有的动作图，帮助保持比例。角色长相由原模板的身份部分和参考图提供。
- **动作规则通用：** 根据角色已有的身体结构操作电脑；没有合适操作肢体时，改用书。动作段不写死物种、毛色或某只宠物的名字。

## State action（替换 `STATE_PROMPTS["running"]`）

```text
Quiet study loop: the reference pet studies at one small laptop using tiny, readable alternating movements of its existing hands, paws, or other suitable manipulators. Keep the head, torso and overall silhouette almost still; the screen-directed attention and small deliberate keyboard taps should clearly read as studying, calm and focused. Adapt the working pose to the reference pet's existing anatomy and proportions. If the pet has no suitable pair of manipulators, use one small open book and a restrained reading loop instead. This is active task work, not foot-running, jogging, sprinting, treadmill motion, raised knees, long steps, pumping arms, or directional travel.
```

## State requirements（替换 `STATE_REQUIREMENTS["running"]`）

```text
- Keep the exact character construction from the attached canonical base and any supplied approved existing-action reference: same relative head and body size, face and eye scale, torso length and thickness, limb lengths, silhouette, materials, markings, and palette. Working must not make the pet wider, rounder, shorter, younger, or more stylized than those references.
- Choose a natural, comfortable working posture that fits the reference pet's anatomy (standing, sitting, resting, or hovering as feels most natural for that character). Do not force non-sitting characters into a seated posture, change its skeletal proportions to reach the prop, or invent extra limbs.
- Show exactly one simple low-detail laptop, resting against the pet on an anatomically suitable support or in front of its existing manipulators. The prop must touch or overlap the pet silhouette and must not shrink the pet to fit the frame.
- Keep the laptop no wider than the pet's body and below its upper body or main identifying feature. Angle it and lower its open lid enough that the keyboard and BOTH operating manipulators stay separately visible in every frame; the lid must not hide either operating extremity or its connection to the body.
- Keep the laptop's size, shape, angle, position, and keyboard identical across all 6 frames. Use the pet's palette and material style, avoiding the chroma-key color. Draw no text, logos, symbols, code, icons, UI, glow, or reflections on the laptop.
- For pets with two suitable operating manipulators, use this six-frame choreography in VIEWER coordinates: frames 1-2, viewer-left presses its keys while viewer-right lifts; frames 3-4, viewer-left lifts while viewer-right presses; frames 5-6, return to viewer-left pressing while viewer-right lifts. Frame 6 should join frame 1 smoothly.
- Make each left/right reversal readable through actual movement of the existing operating limbs. The lifted extremity moves no more than half its own height above its keys while the pressing extremity touches the keyboard; use clear alternating contact rather than large lifts. Keep the two manipulators separated, attached, and unobscured. Do not replace alternation with simultaneous movement, movement of only one manipulator, or six copied poses.
- Keep the same quiet study pose throughout: no repeated body bobbing, large nods, energetic typing, swaying, bouncing, waving or exaggerated reactions. Use only small operating movements and focused attention toward the task; a small natural blink or equivalent character-appropriate micro-movement may occur in frame 4. Preserve normal face and body proportions during the blink and throughout the row.
- If the character lacks two suitable manipulators, use one small open book instead of the laptop. Preserve its existing anatomy; show focus through a small natural looking or aiming movement and, where anatomically possible, one restrained page interaction. Do not add hands, paws, arms, eyes, or a humanoid body to enable the action.
- The book follows the same single-prop, size, fixed-position, attached-silhouette, material, and chroma-key restrictions as the laptop. Keep first and last frames close for a calm loop.
- Add no desk, chair, cup, papers, second device, second prop, floating symbol, sparkle, thought bubble, scenery, shadow, glow, motion arc, speed line, dust, motion trail, or detached effect.
- Do not show literal foot-running, jogging, sprinting, treadmill motion, raised knees, long steps, pumping arms, or directional travel.
```

## 试画与回退

栗子试画保留了花色和面部特征，头身偏圆、躯干偏短，部分帧的换爪和遮挡仍可改进。新版强调幅度小、安静，并能看出在学习，继续用参考图保持长相和比例。

制作脚本只覆盖上面的动作和要求两段。运行目录会保留原始完整提示词，切回 `original` 时逐字恢复。原版生成器和宠物原图继续保留。
