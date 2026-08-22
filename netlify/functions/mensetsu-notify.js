// netlify/functions/mensetsu-notify.js
//
// mimemime「はじめての模擬面接」を完了し、案内メールの受け取りに同意した人にだけ、
// 対面での模擬面接練習（mimen）の案内メールを送る。
// mensetsu-ai.html の notifyIfOptedIn() から、finishInterview() 成功後に1回だけ呼ばれる。
//
// 必須の環境変数（Netlifyのサイト設定 > Environment variables で設定）:
//   RESEND_API_KEY    = Resend APIキー
//   NOTIFY_FROM_EMAIL = 送信元メールアドレス（Resend側でドメイン認証済みのもの）
//
// 上記が未設定の場合は、何もせず200を返す（社長が設定を終えるまで、
// フロント側の体験（フィードバック表示など）を壊さないため）。

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.NOTIFY_FROM_EMAIL;
  if (!apiKey || !fromEmail) {
    return {
      statusCode: 200,
      body: JSON.stringify({ skipped: true, reason: 'RESEND_API_KEY or NOTIFY_FROM_EMAIL not set' }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const email = String(payload.email || '').trim();
  if (!email || !email.includes('@')) {
    return { statusCode: 400, body: JSON.stringify({ error: 'valid email is required' }) };
  }

  const bodyText = [
    '模擬面接の練習、お疲れさまでした。',
    '',
    'もしよければ、次は実際に人と話す練習もできます。',
    '元就労移行支援員の「おのざる」が、一対一でゆっくり模擬面接の練習に付き合います。',
    '評価の場ではなく、あなたが本来どう話したいかを一緒に探す時間です。',
    '',
    'ご興味があれば、このメールに返信するか、次にサイトを訪れたときに',
    '「実際の面接練習に申し込む」ボタンからご連絡ください。',
    '',
    '— mimemime',
  ].join('\n');

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: fromEmail,
        to: email,
        subject: 'はじめての模擬面接、お疲れさまでした',
        text: bodyText,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return {
        statusCode: 502,
        body: JSON.stringify({ error: 'Resend API error', detail: errText.slice(0, 500) }),
      };
    }

    return { statusCode: 200, body: JSON.stringify({ sent: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err) }) };
  }
};
