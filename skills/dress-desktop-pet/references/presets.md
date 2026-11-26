# 预设换装时间表

`dress.py init` 支持通过 `--preset <名字>` 直接挂接常用自动换装规则，也支持用 `--schedule-json '<JSON>'` 自定义任意符合随伴衣柜规范的规则。省略两者时，衣服只会加入衣柜供用户手动切换。

## 内置预设（`--preset`）

| 预设名 | 中文建议名 | 自动生效条件 | 对应 `when` JSON |
| --- | --- | --- | --- |
| `pajamas` | 睡衣 | 每天 22:00 – 次日 07:00 | `{"time": {"from": "22:00", "to": "07:00"}}` |
| `weekend` | 周末装 | 每周六、周日全天 | `{"days": ["sat", "sun"]}` |
| `summer` | 夏日装 | 每年 6 月 1 日 – 8 月 31 日 | `{"dates": {"from": "06-01", "to": "08-31"}}` |
| `halloween` | 万圣节 | 每年 10 月 25 日 – 11 月 1 日 | `{"dates": {"from": "10-25", "to": "11-01"}}` |
| `holidays` | 节日装 | 每年 12 月 15 日 – 次年 1 月 5 日 | `{"dates": {"from": "12-15", "to": "01-05"}}` |

## 自定义 `--schedule-json`

可传入完整规则对象，或只传 `when` 对象（脚本会自动补齐 `"outfit": "<slug>"`）：

```json
{
  "outfit": "raincoat",
  "when": {
    "time": { "from": "08:00", "to": "18:00" },
    "days": ["mon", "tue", "wed", "thu", "fri"]
  }
}
```

字段约束（与随伴 `wardrobe.rs` 一致）：
- `when` 至少包含 `time`、`days`、`dates` 中的一项。
- `time`：`from` 和 `to` 均为 24 小时制 `HH:MM` 且不能相同（支持跨午夜，如 `22:00` → `07:00`）。
- `days`：非空数组，元素取值限定为 `sun`、`mon`、`tue`、`wed`、`thu`、`fri`、`sat`。
- `dates`：`from` 和 `to` 均为 `MM-DD`（支持跨年，如 `12-15` → `01-05`）。
- 可选 `"enabled": false` 表示初始暂停，让用户在随伴衣柜里手动开启。
