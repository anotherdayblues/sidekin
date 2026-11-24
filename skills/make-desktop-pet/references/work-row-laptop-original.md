# “专心工作”行的电脑版提示词（草稿，待用户定）

用途见 `plan/19-番茄钟-调研.md` 第 2.1 节：原版画出来的“专心工作”（`running`，第 8 行，6 帧）和待机几乎一样，番茄钟专注时看不出宠物在干活。电脑版让这一行拿一件贴身的小道具，默认是小笔记本电脑，没有手爪的宠物换成一本小书。

- **原版不动：** 原版在 `vendor/hatch-pet/scripts/prepare_pet_run.py` 的 `STATE_PROMPTS["running"]` 和 `STATE_REQUIREMENTS["running"]`。
- **本文件只是草稿：** 还没有接进任何脚本。
- **写法照原版：** 一句 `State action`，几条 `State requirements`，用英文短句；先写要画什么，再写不许画什么。
- **以后接入时：** 只替换下面两段，整体模板（身份、风格、去背景要求）照旧。

## State action（替换 `STATE_PROMPTS["running"]`）

```text
Working loop: the pet sits or stands at a small laptop held close to its body, typing with alternating paws, glancing at the screen, giving a small focused nod or blink; clearly busy at a task, calm and steady, not literal foot-running, jogging, sprinting, treadmill motion, raised knees, long steps, pumping arms, or directional travel.
```

## State requirements（替换 `STATE_REQUIREMENTS["running"]`）

```text
- Show the pet clearly working at one small laptop: the laptop rests on its lap, on the ground in front of its feet, or in its front paws, touching or overlapping the pet silhouette.
- If the pet has no usable paws, hands, or limbs, use one small open book in the same position instead, and show work through reading, head bobs, and blinks.
- The laptop or book is a new prop allowed only in this row; draw it simple, low-detail, and in the pet's own palette and material style, never in pure magenta, green, or any color close to the chroma key.
- Keep the prop no wider than the pet's body and no taller than its shoulders, so the pet is not shrunk to fit the frame slot.
- Keep the prop's size, angle, and position identical across all 6 frames; animate only paws, head, ears, eyes, tail, or body bob.
- Paws alternate visibly on the keyboard (or turn a page once) across the loop, with at least one focused nod or blink, so the row reads as working at a glance and does not look like idle or review.
- The laptop screen faces the pet and is seen from the back or the side; draw no text, code, icons, UI, light, glow, or reflection on it.
- Do not draw sparkles, thought bubbles, floating symbols, coffee cups, desks, chairs, papers, extra devices, or any second prop.
- Do not show literal foot-running, jogging, sprinting, treadmill motion, raised knees, long steps, pumping arms, directional travel, speed lines, dust clouds, floor shadows, motion trails, or detached motion effects.
- The first and last frames should be close visually so the loop does not pop.
```

## 每一条为什么这样写

| 要求 | 原因 |
|---|---|
| 道具贴着或压住身体 | 去背景时，离开身体的东西会被当成“漂浮特效”删掉 |
| 不比身体宽、不高过肩 | 统一配准按可见轮廓缩放，道具太大，宠物会被缩小 |
| 6 帧里道具不动 | 道具最容易在帧间走样；固定住，只动爪子、头、眼、尾巴 |
| 屏幕背对宠物或侧对，不画字和光 | 生图模型画的字会乱；发光会被去背景当成光晕删掉，原版模板也禁止光晕 |
| 颜色避开品红和绿 | 这两种是去背景用的底色 |
| 只许一件道具 | 防止画出桌子、杯子、纸张，撑大轮廓 |
| 没手爪的宠物换成书 | 有的形象没法敲键盘 |
| 保留原版的“不是跑步”那条 | 这一行在代码里叫 `running`，模型容易画成跑步 |
| 首尾两帧接近 | 和待机行一样，循环时不跳 |

## 还没定的
- 默认道具用小电脑还是书：用户说先固定用电脑，用户主动说想换才换。
- 用户自己做的宠物本来就带道具（比如抱着一把吉他）时，两件道具会挤在一起。可以加一条：“已有道具时，放下或收在身旁”，要先在 Mac 上真生成看看。
- 接入方式还没做，计划见 `plan/19` 第 2.1 节：`project.py prepare` 和 `repair` 加一个 `--work-row original|laptop` 选项，默认仍用原版，并记下每只宠物用的是哪个版本。
