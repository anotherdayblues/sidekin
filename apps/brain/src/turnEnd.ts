// Like Hermes's stall guard, inspect short acknowledgments at the end of a turn.
// A timed promise also needs scheduling evidence, even if another tool ran.
const timing =
  /(?:\d+|[一二两兩三四五六七八九十半]+)\s*(?:[个個])?\s*(?:秒[钟鐘]?|分[钟鐘]?|小[时時]|天|[周週])(?:以|之)?[后後]|每天|每[周週]|明天|[后後]天|稍[后後]|[过過]一[会會]|\b(?:in\s+\d+\s+(?:seconds?|minutes?|hours?)|tomorrow|every day|every week)\b|(?:\d+|[一二三四五六七八九十半]+)\s*(?:秒|分|時間|日|週間)(?:後|あと)|毎日|毎週|明日|明後日|後で|あとで|しばらくしたら|(?:\d+|한|두|세|네|다섯|열|반)\s*(?:초|분|시간|일|주)\s*(?:후|뒤)|매일|매주|내일|모레|이따가?|조금\s?있다/i;
const claim =
  /(?:已[经經]|已|都|[给給]你|定好|[设設]好|安排好|[记記]下).{0,8}(?:安排|[设設]置|定[时時]|提醒|[闹鬧][钟鐘]|排[队隊]|[设設]好|定好)|(?:安排好|[设設]好|定好|排上)(?:了|啦)|\b(?:scheduled|set (?:the |a |your )?(?:timer|reminder)|queued)\b|(?:リマインダー|リマインド|タイマー|通知|アラーム|予定|スケジュール).{0,12}(?:設定|セット|登録|予約)(?:しました|した|済み|完了)|(?:設定|セット|登録|予約)(?:しました|したよ|しておきました)|(?:알림|리마인더|타이머|알람|일정).{0,12}(?:설정|등록|예약)(?:했|해\s?뒀|완료)|(?:설정|등록|예약)(?:했습니다|했어요|해\s?뒀어요|해\s?두었습니다|완료)/i;
const undertaking =
  /(?:我[会會]|我到[时時]|到[时時]|到[点點]|[届屆][时時]|待[会會]|稍[后後]|就去|[后後]去|[后後].{0,6}(?:查|[发發]|告[诉訴]|提醒|[帮幫]|[处處]理|整理)|好[呀的啦，,]).{0,90}(?:查|[发發]|告[诉訴]|[说說][给給]|提醒|安排|[办辦]|[处處]理|整理)|\b(?:i['’]ll|i will)\b|(?:後で|あとで|時間になったら|その時に|後ほど|わかりました|承知しました|了解).{0,60}(?:お知らせ|通知|リマインド|調べ|確認|伝え|送り|まとめ)|(?:이따가?|시간이?\s?되면|후에|뒤에|알겠어요|알겠습니다|네,).{0,60}(?:알려\s?드릴|알려\s?줄|확인해|찾아|전해|보내|정리해|리마인드)/i;
const refusal =
  /[没沒]有(?:[设設]好|[创創]建|安排)|[没沒]能(?:[创創]建|安排)|[无無]法|不能|做不到|失[败敗]|\b(?:cannot|can['’]t|unable|failed)\b|(?:設定|作成|登録|予約)でき(?:ません|なかった)|できません|失敗|無理|(?:설정|생성|등록|예약)할\s?수\s?없|(?:설정|생성|등록|예약)(?:하지\s?못|에\s?실패)|할\s?수\s?없|불가능|실패/i;

export function isReminderCreationRequest(text: string): boolean {
  return (
    /提醒(?:我|一下|喝水)|\bremind me\b|リマインド|リマインダー|通知して|알려\s?줘|알려\s?주세요|알림\s?(?:설정|맞춰|해|추가)|리마인드/i.test(
      text,
    ) &&
    !/[?？“”「」『』]|假如|如果|举例|舉例|意思|解释|解釋|もし|たとえば|例えば|どういう意味|만약|예를\s?들어|무슨\s?뜻|\b(?:what does|for example|suppose)\b/i.test(
      text,
    ) &&
    /后|後|明天|点|點|分钟|分鐘|小时|小時|每天|每周|每週|\b(?:in\s+\d+|tomorrow|every\s+(?:day|week)|at\s+\d|minutes?|hours?|seconds?)\b|あと|明日|毎日|毎週|時|分|秒|후에?|뒤에?|내일|매일|매주|\d+\s*(?:시|분|초|시간)/i.test(
      text,
    ) &&
    !/取消|删除|刪除|暂停|暫停|有哪些|不要|\b(?:cancel|delete|remove|pause|list|what reminders|don['’]t)\b|キャンセル|削除|消して|一時停止|止め|一覧|何がある|しないで|취소|삭제|지워|일시\s?정지|목록|뭐가\s?있|하지\s?마/i.test(
      text,
    )
  );
}

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
    /(?:\b(?:let me now|i['’]ll now|i will now|next,? i)\b[^.!?\n]{0,100}|(?:我[现現]在就|我[这這]就|我[这這]就[来來]|我先[来來])(?:去|[帮幫]你)?(?:查|搜|[读讀]取|[调調]用|[处處]理|整理)[^。！？\n]{0,65}|(?:今から|これから|すぐ|まず)(?:調べ|検索し|確認し|読み込|処理し|整理し)[^。！？\n]{0,65}|(?:지금\s?바로|바로|먼저)\s*(?:찾아|검색해|확인해|읽어|처리해|정리해)[^.!?\n]{0,65})[。.!！～~…：:\s]*$/i.test(
      reply,
    )
  );
}
