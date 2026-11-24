# 其他 AI 的生图规则

仅供其他 AI 使用。Codex 跳过本文，沿用原有 `$imagegen` 流程。

## 次数上限：每张最多 5 次

一个生图任务（主形象、某一行动作、方向图）最多生成 5 张。

- 5 张里有通过检查的，就用它。
- 5 张都不通过，就停下。把最好的一张和没通过的原因告诉用户，让用户选：再试一轮、用这张，还是换生图工具。用户同意后，才开始新的一轮，新一轮同样最多 5 张。
- 生图工具报额度用完、限流或其他错误（例如 429），立即停下，告诉用户原文和恢复时间。不换提示词、不换子代理接着试。

派子代理时，把这几条原样写进子代理的提示词。子代理每生成一张，都要在回报里写已用张数。

## 每次都要做

读取当前任务的 `prompt_file` 和 `input_images`。相对路径以本次工作目录为起点。把清单里的全部图片实际传给生图工具，并在提示词中按顺序说明用途。主形象用于保持长相；排版图只参考帧数、间距和留白。

**只在提示词里写本地路径，或你自己看过图片，都不算传图。** 内置工具用图片附件或专用图片参数；API 按下表提交图片内容。Base64 是脚本把图片文件转换成可发送的数据。

## API 方法：只读所用平台的一行

| 平台 | 参考图怎么传 | 官方文档 |
| --- | --- | --- |
| OpenAI | Python SDK 调用 `images.edit`，逐张以二进制打开文件，放入 `image` 列表。 | [图像编辑接口](https://developers.openai.com/api/reference/python/resources/images/methods/edit) |
| Google Gemini / Nano Banana | Interactions 接口在 `input` 列表中加入多个 `type: image` 项；每项填写 Base64 `data` 和 `mime_type`。 | [生图与编辑](https://ai.google.dev/gemini-api/docs/image-generation) |
| 字节 Seedream | 将每张图转成 `data:image/<格式>;base64,...`，或使用接口可访问的图片网址，按顺序放入 `image` 数组。 | [生图接口](https://docs.byteplus.com/en/docs/modelark/image-generation-api) |
| 阿里 Qwen 图像编辑 | 在用户消息的 `content` 列表中逐张添加 `image` 项，填写 Base64 数据地址或可访问的网址，同时添加 `text` 要求。 | [图像编辑指南](https://help.aliyun.com/en/model-studio/qwen-image-edit-guide) |
| FLUX.2 | 把图片网址或 Base64 分别填入 `input_image`、`input_image_2` 等字段。 | [多图编辑](https://docs.bfl.ai/flux_2/flux2_image_editing) |
| xAI Grok Imagine | 官方 SDK 使用 `image_urls` 列表，逐张填写图片网址或 Base64 数据地址。 | [多图编辑](https://docs.x.ai/developers/model-capabilities/images/multi-image-editing) |

提交前核对图片数量、顺序和所选模型的上限。数量不足时，先说明差额，再与用户确定可附齐图片的模型或工具，不能自行漏图。

API key 用于授权，图片仍需单独传入。按所选平台配置 key；第三方中转服务按其实际接口文档填写参数。表中方法核对于 2026-11-07，使用时按链接核对具体模型和接口版本。
