// netlify/functions/mensetsu-chat.js
//
// mimemime「はじめての模擬面接」フィードバック生成用エンドポイント
// mensetsu-ai.html の finishInterview() から呼ばれる。
//
// 必須の環境変数（Netlifyのサイト設定 > Environment variables で設定）:
//   ANTHROPIC_API_KEY = Anthropic APIキー
//
// コスト対策: 1セッション（8問完了）につきAI呼び出しは1回のみ。
// 質問ごとの相づちはフロント側で静的に処理しているため、API課金は発生しない。

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

  const { qaList } = payload;
  if (!Array.isArray(qaList) || qaList.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'qaList is required' }) };
  }

  // 想定外の長文送信によるコスト増を防ぐため、1回答あたり2000文字で切る
  const transcript = qaList
    .map((qa, i) => {
      const q = String(qa.question || '').slice(0, 500);
      const a = String(qa.answer || '').slice(0, 2000);
      return `Q${i + 1}. ${q}\nA${i + 1}. ${a}`;
    })
    .join('\n\n');

  const systemPrompt = `あなたはmimemime（障がい者就労支援サービス）の模擬面接パートナーです。
利用者が模擬面接の全質問に回答し終えました。以下のルールを必ず守ってフィードバックを書いてください。

- 点数・評価・順位・「合格」「不合格」的な表現は一切使わない
- 他の利用者と比較しない
- 「できていない」ではなく「気づき」「次に試せること」という言葉で伝える
- 良かった点を、回答内容から具体的に1つ以上挙げる
- 次に試せることを1〜2個、命令形ではなく提案の形で伝える（例:「〜してみるのはどうでしょう」）
- 医療的な診断や断定的な予測（採用の可否など）は絶対に行わない
- 読んだ人が安心し、また挑戦したくなるような温かいトーンで書く
- 日本語で300〜500字程度
- 実在の企業名や「株式会社」という表記は使わない`;

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
        max_tokens: 700,
        system: systemPrompt,
        messages: [
          { role: 'user', content: `以下が模擬面接の一問一答です。\n\n${transcript}` },
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
    const feedback = (data && data.content && data.content[0] && data.content[0].text) || '';

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ feedback }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err) }) };
  }
};
