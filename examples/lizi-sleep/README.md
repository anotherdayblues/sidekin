# 栗子的持续睡眠

这是独立的教学草稿。横条沿用栗子已有的入睡和起身画面，用闭眼姿势制作八帧呼吸。第 1～4 帧入睡，第 5～12 帧循环，第 13～16 帧醒来。呼吸时胸背起伏，脚底位置固定。点宠物请求收尾，当前呼吸播完再起身。

三段素材和播放顺序参考 [VPet 的睡眠素材](https://github.com/LorisYounger/VPet/tree/c26be33d730ea5547711f6cc9781cf94e4d6ac7d/VPet-Simulator.Windows/mod/0000_core/pet/vup/Sleep) 及其 [DisplaySleep](https://github.com/LorisYounger/VPet/blob/c26be33d730ea5547711f6cc9781cf94e4d6ac7d/VPet-Simulator.Core/Display/MainDisplay.cs#L332-L343)。随伴将三段存入同一张横条，使用 loopFrames 标出保持段。结束时更改当前循环的下一段，参考 [Unreal Montage 的 Start、Loop、End 示例](https://dev.epicgames.com/documentation/en-us/unreal-engine/editing-an-animation-montage?application_version=4.27)。这里复用播放方式，画面来自栗子。
