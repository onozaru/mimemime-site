// netlify/functions/mensetsu-voice-analyze.js
//
// mimemime「はじめての模擬面接」の音声練習を分析するエンドポイント。
// mensetsu-ai.html の requestVoiceAnalysis() から、録音済み音声(base64)を受け取って呼ばれる。
//
// 処理の流れ:
//   1. OpenAI Whisper API で音声を文字起こし（単語ごとのタイムスタンプ付き）
//   2. タイムスタンプから「話す速さ」「間の取り方」を実測値として計算
//   3. 文字起こしからフィラー語（「えーと」「あの」など）を数える
//   4. 上記の数値と文字起こしをAnthropic APIに渡し、文章での説明を書かせる
//      （数値そのものはコードで計算した実測値。文章部分だけAIが書く）
//
// 必須の環境変数（Netlifyのサイト設定 > Environment variables で設定）:
//   OPENAI_API_KEY    = OpenAIのAPIキー（Whisperでの文字起こし用）
//   ANTHROPIC_API_KEY = Anthropic APIキー（mensetsu-chat.jsと共用）
//
// 未設定の場合は、その旨を明示するエラーを返す（フロント側は「準備中」表示にフォールバック）。
//
// 要確認・未検証の点（実データで調整が必要）:
//   - Whisperの「単語」区切りは日本語の場合、英語のような分かち書きの単語単位とは限らない。
//     話す速さの目安値（IDEAL_CHARS_PER_MIN）や間の取り方のしきい値(PAUSE_THRESHOLD_SEC)は
//     暫定値であり、実際の利用者の録音で聞き比べて調整すること。
//   - フィラー語の検出は単純な文字列一致であり、辞書に無い言い回しは拾えない。

const PAUSE_THRESHOLD_SEC = 0.6; // これより長い単語間の空白を「間」として数える
const IDEAL_CHARS_PER_MIN = { min: 220, max: 340 }; // 暫定：日本語の落ち着いた会話速度の目安（要調整）
const FILLER_WORDS = ['えーと', 'えっと', 'えーっと', 'あのー', 'あの', 'そのー', 'まあ', 'なんか', 'んーと', 'えー'];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!openaiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'OPENAI_API_KEY が設定されていません。音声分析にはWhisper APIのキーが別途必要です。' }),
    };
  }
  if (!anthropicKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY が設定されていません。' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const audioBase64 = payload.audio;
  const mimeType = String(payload.mimeType || 'audio/webm');
  if (!audioBase64) {
    return { statusCode: 400, body: JSON.stringify({ error: 'audio (base64) is required' }) };
  }

  // Netlify Functions(同期呼び出し)のリクエスト上限(約6MB)を踏まえ、
  // 長時間録音を誤って送られた場合は先に弾く（目安: 3分/webmでおよそ2〜3MB程度）
  if (audioBase64.length > 7_000_000) {
    return { statusCode: 413, body: JSON.stringify({ error: '録音が長すぎます。3分以内でお試しください。' }) };
  }

  let transcribed;
  try {
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    const blob = new Blob([audioBuffer], { type: mimeType });
    const form = new FormData();
    form.append('file', blob, 'recording.webm');
    form.append('model', 'whisper-1');
    form.append('language', 'ja');
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: `Bearer ${openaiKey}` },
      body: form,
    });

    if (!res.ok) {
      const errText = await res.text();
      return { statusCode: 502, body: JSON.stringify({ error: 'Whisper API error', detail: errText.slice(0, 500) }) };
    }
    transcribed = await res.json();
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'transcription failed: ' + String(err) }) };
  }

  const transcriptText = String(transcribed.text || '').trim();
  const durationSec = Number(transcribed.duration || 0);
  const words = Array.isArray(transcribed.words) ? transcribed.words : [];

  if (!transcriptText || durationSec <= 0) {
    return { statusCode: 502, body: JSON.stringify({ error: '文字起こしに失敗しました。もう一度録音してお試しください。' }) };
  }

  // ---- 話す速さ（文字数ベース。日本語のためWhisperの「単語」数ではなく文字数を使う） ----
  const charCount = transcriptText.replace(/\s/g, '').length;
  const charsPerMin = charCount / (durationSec / 60);
  const paceScore = scoreAgainstRange(charsPerMin, IDEAL_CHARS_PER_MIN.min, IDEAL_CHARS_PER_MIN.max);
  const paceNote =
    charsPerMin < IDEAL_CHARS_PER_MIN.min ? 'ゆっくりめでした' :
    charsPerMin > IDEAL_CHARS_PER_MIN.max ? '少し早口でした' : 'ちょうど良いペースです';

  // ---- 間の取り方（単語タイムスタンプ間の空白から算出） ----
  let pauseCount = 0;
  let pauseTotalSec = 0;
  for (let i = 1; i < words.length; i++) {
    const gap = Number(words[i].start) - Number(words[i - 1].end);
    if (gap > PAUSE_THRESHOLD_SEC) {
      pauseCount++;
      pauseTotalSec += gap;
    }
  }
  const avgPauseSec = pauseCount > 0 ? pauseTotalSec / pauseCount : 0;
  // 間が全く無い(0回)は詰め込みすぎ、多すぎるのも間延びのため、2〜6回/分を目安の中心とする（暫定・要調整）
  const pausesPerMin = pauseCount / (durationSec / 60);
  const pauseScore = scoreAgainstRange(pausesPerMin, 2, 6);
  const pauseNote =
    words.length < 2 ? '計測できるほど言葉数がありませんでした' :
    pausesPerMin < 2 ? '間が短めでした' :
    pausesPerMin > 6 ? '間が多めでした' : 'ちょうど良い間が取れています';

  // ---- フィラー語（単純な文字列一致） ----
  let fillerCount = 0;
  for (const w of FILLER_WORDS) {
    fillerCount += transcriptText.split(w).length - 1;
  }
  const fillerPerMin = fillerCount / (durationSec / 60);
  const fillerScore = 100 - Math.min(100, Math.round(fillerPerMin * 15)); // 多いほどスコアを下げる（暫定式）

  const metrics = {
    pace: { score: paceScore, note: paceNote, charsPerMin: Math.round(charsPerMin) },
    pause: { score: pauseScore, note: pauseNote, count: pauseCount, avgPauseSec: Math.round(avgPauseSec * 10) / 10 },
    filler: { score: fillerScore, note: `1分あたり${fillerPerMin.toFixed(1)}回`, count: fillerCount },
  };

  // ---- 文章での説明はAnthropic APIに実測値をもとに書かせる ----
  let feedbackText = '';
  try {
    const systemPrompt = `あなたはmimemime（障がい者就労支援サービス）の模擬面接パートナーです。
利用者が声に出して練習した録音を分析した実測値をもとに、短い講評を書いてください。

- 点数・評価・順位につながる表現は使わない
- 渡された数値以外の、根拠のない断定はしない
- 良かった点を1つ、次に試せることを1つ、提案の形で伝える
- 日本語で150〜250字程度
- 「AI」という単語は使わない`;
    const userContent = `文字起こし: ${transcriptText.slice(0, 1000)}

実測値:
- 話す速さ: ${metrics.pace.note}（1分あたり${metrics.pace.charsPerMin}文字）
- 間の取り方: ${metrics.pause.note}（${durationSec.toFixed(0)}秒間で${metrics.pause.count}回、平均${metrics.pause.avgPauseSec}秒）
- 「えーと」「あの」等のつなぎ言葉: ${metrics.filler.note}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      }),
    });
    if (res.ok) {
      const data = await res.json();
      feedbackText = (data && data.content && data.content[0] && data.content[0].text) || '';
    }
  } catch (e) { /* 文章生成に失敗しても数値は返す */ }

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ metrics, feedbackText, transcript: transcriptText }),
  };
};

function scoreAgainstRange(value, min, max) {
  if (value < min) return Math.max(0, Math.round(100 - ((min - value) / min) * 100));
  if (value > max) return Math.max(0, Math.round(100 - ((value - max) / max) * 100));
  return 100;
}
