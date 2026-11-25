"""Deliver a catalogue proposal, never credentials or executables."""
import argparse
import json
import os
import re
import shutil
import sys
import time
import uuid
from pathlib import Path

def inbox_path():
    if os.getenv("PET_STUDIO_DATA"):
        return Path(os.environ["PET_STUDIO_DATA"]).expanduser() / "inbox"
    if sys.platform == "darwin":
        base = Path.home() / "Library/Application Support"
    elif sys.platform == "win32":
        base = Path(os.environ["APPDATA"])
    else:
        base = Path(os.getenv("XDG_DATA_HOME", Path.home() / ".local/share"))
    return base / "app.suiby.desktop/inbox"

def receipt(inbox, ticket):
    if not re.fullmatch(r"tool-[a-f0-9]{32}", ticket):
        raise ValueError("投递编号无效")
    for prefix in [".decision-", ".done-"]:
        path = inbox / (prefix + ticket + ".json")
        if path.is_file() and not path.is_symlink():
            return json.loads(path.read_text())
    if (inbox / (".failed-" + ticket)).exists():
        return {"status":"refused","ticket":ticket}
    return {"status":"queued" if (inbox/ticket).exists() else "unknown","ticket":ticket}

def send(inbox, tool, reason, wait=5):
    catalogue = json.loads((Path(__file__).resolve().parents[1]/"catalog.json").read_text())
    if not any(row["id"] == tool for row in catalogue):
        raise ValueError("清单里没有这个工具")
    # One plain sentence in Chinese or English: no links, addresses, numbers or keys.
    # A full stop may only end it. Suiban checks the same rule on arrival.
    if (not re.fullmatch(r"[一-鿿，。、！？ a-zA-Z,.!?'\-]{1,100}", reason)
            or not reason.strip()
            or "." in reason.strip().rstrip(".!?")):
        raise ValueError("请用一句简短的中文或英文说明用途，不要包含网址、数字或账号 / Use one short plain sentence: no links, numbers or accounts")
    ticket = "tool-" + uuid.uuid4().hex
    inbox.mkdir(exist_ok=True, parents=True)
    tmp = inbox/(".tmp-"+ticket)
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir()
    try:
        (tmp/"tool.json").write_text(json.dumps({"id":tool,"reason":reason},ensure_ascii=False), encoding="utf-8")
        tmp.rename(inbox/ticket)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    deadline = time.monotonic() + wait
    while time.monotonic() < deadline:
        if any((inbox / (prefix + ticket + suffix)).exists() for prefix, suffix in [
            (".done-", ".json"), (".decision-", ".json"), (".failed-", "")
        ]):
            break
        time.sleep(0.2)
    return receipt(inbox, ticket)

if __name__ == "__main__":
    parser=argparse.ArgumentParser()
    cmds=parser.add_subparsers(dest="action",required=True)
    add=cmds.add_parser("send"); add.add_argument("id"); add.add_argument("reason")
    cmds.add_parser("status").add_argument("ticket")
    args=parser.parse_args(); inbox=inbox_path()
    print(json.dumps(send(inbox,args.id,args.reason) if args.action=="send" else receipt(inbox,args.ticket),ensure_ascii=False))
