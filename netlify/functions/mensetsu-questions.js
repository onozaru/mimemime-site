// netlify/functions/mensetsu-questions.js
//
// mimemime「はじめての模擬面接」の、企業タイアップ用質問セット生成エンドポイント。
// mensetsu-ai.html の startInterview() から、会社名または会社メモが入力された場合のみ呼ばれる。
// 空欄の場合はフロント側がこの関数を呼ばず、既定の質問セット(QUESTIONS_DEFAULT)を使う。
//
// 必須の環境変数（Netlifyのサイト設定 > Environment variables で設定）:
//   ANTHROPIC_API_KEY = Anthropic APIキー
//
// 注意: このエンドポイントは会社URLへのアクセス・スクレイピングは行わない。
// 入力された会社名・メモのテキストのみをもとに質問を組み立てる。

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'ANTHROPIC_API_KEY が設定されていません。Netlifyの環境変数を確認してください。' }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const companyName = String(payload.companyName || '').slice(0, 200);
  const companyMemo = String(payload.companyMemo || '').slice(0, 1000);
  if (!companyName && !companyMemo) {
    return { statusCode: 400, body: JSON.stringify({ error: 'companyName or companyMemo is required' }) };
  }

  const systemPrompt = `あなたはmimemime（障がい者就労支援サービス）の模擬面接パートナーです。
利用者が受けたい会社についての情報をもとに、障害者雇用枠の模擬面接で使う質問をちょうど8問作成してください。

- 1問目は必ず自己紹介・経歴を聞く質問にする
- 8問目は必ず「面接官への逆質問はあるか」を聞く質問にする
- 入力された会社名やメモに具体的な記載があればそれに触れてよいが、記載のない事業内容・制度などを勝手に作って断定しない
- 点数・評価・順位につながるような聞き方をしない
- 出力は日本語の質問文だけを8行、前置きや番号なしで1問1行で返す（1行目〜8行目がそのまま質問1〜8になる）`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: `会社名: ${companyName || '(未入力)'}\nこの会社について知っていること: ${companyMemo || '(未入力)'}`,
          },
        ],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return {
        statusCode: 502,
        body: JSON.stringify({ error: 'Anthropic API error', detail: errText.slice(0, 500) }),
      };
    }

    const data = await res.json();
    const text = (data && data.content && data.content[0] && data.content[0].text) || '';
    const questions = text
      .split('\n')
      .map((s) => s.replace(/^\s*\d+[.)、]\s*/, '').trim())
      .filter(Boolean)
      .slice(0, 8);

    if (questions.length !== 8) {
      // フロント側は既定の質問セットへフォールバックする
      return { statusCode: 502, body: JSON.stringify({ error: 'unexpected question count', raw: text.slice(0, 500) }) };
    }

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ questions }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err) }) };
  }
};
