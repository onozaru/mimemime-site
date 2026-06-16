#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SNS投稿ジェネレーター（就労 × 障害 / 知恵袋スタイル）— スタンドアロン版
------------------------------------------------------------------
Claude Code で「作って」と言えば CLAUDE.md に従って生成されますが、
このスクリプトは「API経由でバッチ生成・自動化(cron)したい」場合の任意の手段です。

使い方:
    pip install anthropic
    export ANTHROPIC_API_KEY=sk-ant-...     # 自分のAPIキー
    python generate.py                       # 未使用テーマから1本
    python generate.py 5                      # 5本まとめて
    python generate.py --theme "休職から復職するのが怖い"
    python generate.py --platform x           # x / note / instagram

出力: output/posts.md に追記、使用済みテーマは progress.json に記録。
"""
import os, sys, json, random, datetime, pathlib

try:
    import anthropic
except ImportError:
    sys.exit("anthropic SDK が必要です:  pip install anthropic")

ROOT = pathlib.Path(__file__).parent
THEMES_FILE = ROOT / "themes.json"
PROGRESS_FILE = ROOT / "progress.json"
OUT_FILE = ROOT / "output" / "posts.md"

# モデル名は環境に合わせて変更可（速度/コスト重視なら haiku、品質重視なら opus）
MODEL = "claude-sonnet-4-6"

SYSTEM_PROMPT = """あなたは、就労移行支援の現役支援員（介護福祉士・当事者性あり、ブランド名 mime mime）の
SNS投稿を作るアシスタントです。Yahoo知恵袋スタイルの「質問 → 会話 → ベストアンサー」形式で、
就労・障害をテーマにしたオリジナル投稿を1本作ります。

絶対ルール:
- 実在の知恵袋Q&Aを転載しない。すべてオリジナルで創作する。実在の人物・相談を再現しない。
- 医療・福祉の断定をしない(「必ず治る」「絶対受かる」等は禁止)。一般的情報＋気持ちへの寄り添いに留める。
- トーンはあたたかく誠実。煽らない。上から目線にしない。絵文字は0〜2個まで。
- 「うまく話せなくていい」の世界観。読む人が責められた気持ちにならないように。
- ベストアンサーは現役支援員の視点で「共感 → 具体的な小さな一歩 → 希望」の順。

出力フォーマット(厳守):
─────────────
テーマ：{カテゴリ} / {テーマ名}
日付：{YYYY-MM-DD}

【質問】
{当事者一人称の相談文 120〜200字}

【会話】
A：{…}
B：{…}
C：{…}   ← 2〜4人ぶん、スレッドが伸びていく感じ

【ベストアンサー】★
{共感→具体的な一歩→希望}

― ベストアンサーに選ばれました ―

{#ハッシュタグ を3〜6個、半角スペース区切り}
─────────────
"""

PLATFORM_NOTE = {
    "x": "プラットフォーム: X。短く、スレッド前提で『1/n』形式の分割案も最後に付ける。",
    "note": "プラットフォーム: note。長め・読み物寄り。導入とまとめを足す。",
    "instagram": "プラットフォーム: Instagram。1枚目=質問、以降=会話、最終枚=ベストアンサー のスライド分割案で出す。",
}


def load_themes():
    data = json.loads(THEMES_FILE.read_text(encoding="utf-8"))
    return data["themes"]


def load_progress():
    if PROGRESS_FILE.exists():
        return json.loads(PROGRESS_FILE.read_text(encoding="utf-8"))
    return {"used": []}


def save_progress(progress):
    PROGRESS_FILE.write_text(json.dumps(progress, ensure_ascii=False, indent=2), encoding="utf-8")


def pick_theme(themes, progress, forced=None):
    if forced:
        for t in themes:
            if t["theme"] == forced:
                return t
        return {"category": "指定", "theme": forced}
    remaining = [t for t in themes if t["theme"] not in progress["used"]]
    if not remaining:
        print("※ 全テーマを一巡しました。2周目に入ります。")
        progress["used"] = []
        remaining = themes[:]
    return random.choice(remaining)


def generate_one(client, theme, platform=None):
    user = f"テーマ：{theme['category']} / {theme['theme']} で、SNS投稿を1本作ってください。"
    if platform and platform in PLATFORM_NOTE:
        user += "\n" + PLATFORM_NOTE[platform]
    resp = client.messages.create(
        model=MODEL,
        max_tokens=1500,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user}],
    )
    return "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")


def main():
    args = [a for a in sys.argv[1:]]
    forced = None
    platform = None
    count = 1
    i = 0
    while i < len(args):
        if args[i] == "--theme" and i + 1 < len(args):
            forced = args[i + 1]; i += 2
        elif args[i] == "--platform" and i + 1 < len(args):
            platform = args[i + 1].lower(); i += 2
        elif args[i].isdigit():
            count = int(args[i]); i += 1
        else:
            i += 1

    client = anthropic.Anthropic()  # ANTHROPIC_API_KEY を環境変数から読む
    themes = load_themes()
    progress = load_progress()
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)

    for n in range(count):
        theme = pick_theme(themes, progress, forced if n == 0 else None)
        text = generate_one(client, theme, platform)
        today = datetime.date.today().isoformat()
        block = f"\n\n<!-- {today} | {theme['category']} / {theme['theme']} -->\n{text}\n"
        with OUT_FILE.open("a", encoding="utf-8") as f:
            f.write(block)
        if theme["theme"] not in progress["used"]:
            progress["used"].append(theme["theme"])
        save_progress(progress)
        print(text)
        print("\n" + "=" * 40)

    print(f"\n完了：{count}本を output/posts.md に追記しました。")


if __name__ == "__main__":
    main()
