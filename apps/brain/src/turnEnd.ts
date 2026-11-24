// Like Hermes's stall guard, inspect short acknowledgments at the end of a turn.
// A timed promise also needs scheduling evidence, even if another tool ran.
const timing =
  /(?:\d+|[一二两三四五六七八九十半]+)\s*(?:个)?\s*(?:秒钟?|分钟|小时|天|周)(?:以|之)?后|每天|每周|明天|后天|稍后|过一会|\b(?:in\s+\d+\s+(?:seconds?|minutes?|hours?)|tomorrow|every day|every week)\b/i;
const claim =
  /(?:已经|已|都|给你|定好|设好|安排好|记下).{0,8}(?:安排|设置|定时|提醒|闹钟|排队|设好|定好)|(?:安排好|设好|定好|排上)(?:了|啦)|\b(?:scheduled|set (?:the |a |your )?(?:timer|reminder)|queued)\b/i;
const undertaking =
  /(?:我会|我到时|到时|到点|届时|待会|稍后|就去|后去|后.{0,6}(?:查|发|告诉|提醒|帮|处理|整理)|好[呀的啦，,]).{0,90}(?:查|发|告诉|说给|提醒|安排|办|处理|整理)|\b(?:i['’]ll|i will)\b/i;
const refusal =
  /没有(?:设好|创建|安排)|没能(?:创建|安排)|无法|不能|做不到|失败|\b(?:cannot|can't|unable|failed)\b/i;
export function timedPromise(request: string, reply: string) {
  if (
    !reply.trim() ||
    reply.length > 450 ||
    refusal.test(reply) ||
    /[?？]\s*$/.test(reply.trim())
  )
    return false;
  return (
    timing.test(request + " " + reply) &&
    (claim.test(reply) || undertaking.test(reply))
  );
}
export function trailingAction(reply: string) {
  return (
    reply.length <= 400 &&
    /(?:\b(?:let me now|i['’]ll now|i will now|next,? i)\b[^.!?\n]{0,100}|(?:我现在就|我这就|我这就来|我先来)(?:去|帮你)?(?:查|搜|读取|调用|处理|整理)[^。！？\n]{0,65})[。.!！～~…：:\s]*$/i.test(
      reply,
    )
  );
}
