# 官方说明索引

`vendor/hatch-pet/SKILL.md` 有 923 行。**不要整份读。** 到了哪个阶段，只读下表对应的那一段：

```bash
sed -n '起,止p' "$SKILL_DIR/vendor/hatch-pet/SKILL.md"
```

行号对应固定版本的原文，测试会检查每段的开头没有变。

## 每次都读（开始时）

| 何时读 | 行 | 开头 |
| --- | --- | --- |
| 开始前：任务有哪些、素材来源规则 | 110–125 | `## Generation Contract` |
| 开始前：进度清单、时间预算、失败后怎么换方法 | 176–229 | `## Visible Progress Plan` |

## 按阶段读

| 何时读 | 行 | 开头 |
| --- | --- | --- |
| 生成第一行动作前：允许的画风、透明和特效规则、每个动作的要求 | 126–175 | `## Pet-Safe Styles` |
| 生成主形象和各行动作时：准备、生成、复制、逐行检查 | 230–350 | `## Default Workflow` |
| 决定向左跑能不能镜像时 | 351–361 | `5. Derive` |
| 九行都通过、拼中间图集时 | 362–439 | `6. When all nine` |
| 开始注视方向前：设计看的方式、方向验收标准 | 440–519 | `## Required V2 Look-Direction Stage` |
| 拼装 v2 图集、去色边、验证、盲测、连续性 | 520–650 | `Assemble the extended atlas` |
| 盲测有分歧或评审不通过时 | 625–638 | `### Blind Review Severity Resolution` |
| 修某一行时 | 859–862 | `## Repair Workflow` |
| 导出前：硬性规则和验收标准 | 863–923 | `## Rules` |

## 派子代理时（只把对应提示词交给子代理）

| 何时读 | 行 | 开头 |
| --- | --- | --- |
| 第一次派子代理前：主对话和子代理各管什么 | 673–735 | `## Lightweight Visual Workers` |
| 主形象子代理的提示词 | 736–756 | `Use this base worker prompt:` |
| 四个主方向子代理的提示词 | 757–776 | `Use this cardinal-strip worker prompt:` |
| 动作行子代理的提示词 | 777–801 | `Use this row worker prompt:` |
| 盲测子代理的提示词 | 802–822 | `Use this blind direction QA worker prompt` |
| 最终检查子代理的提示词 | 823–858 | `Use this final visual QA worker prompt:` |

## 只在特殊情况读

| 何时读 | 行 | 开头 |
| --- | --- | --- |
| 用户给的是已有图集、已有宠物或角色图 | 14–24 | `## Existing Inputs And Upgrades` |
| 用户只给了品牌或公司名 | 55–109 | `## Brand Discovery` |

## 不用读

- 官方的打包段（651–672 行）：本 Skill 改用 `export_pet.py` 导出并送进随伴。
- `vendor/hatch-pet/references/look-direction.md` 和 `worker-prompts.md`：内容和上面的段落重复。
- 所有脚本的源码：要知道参数，就运行 `--help`。
