"""Reversible working-row experiment; changes only the two action blocks."""
import json
import re
from pathlib import Path


def apply(run, mode):
    run = Path(run)
    skill = Path(__file__).resolve().parents[1]
    draft = (skill / 'references/work-row-laptop.md').read_text()
    blocks = re.findall(r'```text\n(.*?)\n```', draft, re.S)
    if len(blocks) != 2:
        raise ValueError('工作动作提示词应包含动作和要求两段')
    originals = run / 'references/original-work-prompts'
    originals.mkdir(parents=True, exist_ok=True)
    for parent in ('rows', 'row-retries'):
        target = run / 'prompts' / parent / 'running.md'
        backup = originals / (parent + '.md')
        if not backup.exists():
            backup.write_bytes(target.read_bytes())
        original = backup.read_text()
        if mode == 'original':
            target.write_bytes(backup.read_bytes())
            continue
        # Retry rows use 'Action:'; normal rows use 'State action:'.
        action_key = 'State action:' if 'State action:' in original else 'Action:'
        pattern = re.escape(action_key) + r'.*?\n\nState requirements:\n.*?(?=\n\n(?:Clean extraction:|One centered))'
        replacement = f'{action_key} {blocks[0]}\n\nState requirements:\n{blocks[1]}'
        result, count = re.subn(pattern, lambda _: replacement, original, flags=re.S)
        if count != 1:
            raise ValueError('没有找到原工作动作段，已保留原文件')
        target.write_text(result)
    request_path = run / 'pet_request.json'
    request = json.loads(request_path.read_text())
    request['work_row'] = mode
    request_path.write_text(json.dumps(request, ensure_ascii=False, indent=2)+'\n')
