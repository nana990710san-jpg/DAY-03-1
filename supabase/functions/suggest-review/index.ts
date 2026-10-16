// AI 한줄평 추천: { name, menu, rating } → { review } (한국어 한 문장, 40자 이내)
// OPENROUTER_API_KEY는 Supabase 프로젝트 Secrets에서 읽는다.

const MODELS = [
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "google/gemma-4-26b-a4b-it:free",
  "google/gemma-4-31b-it:free",
];
const MAX_LEN = 40;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

// 일부 모델은 생각 과정(영어)을 본문에 섞어 보내므로, 한글이 주가 되는 마지막 줄을 고른 뒤
// 첫 문장만 남기고 따옴표·공백을 정리해 40자로 자른다
function cleanReview(text: string): string {
  const lines = text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .split("\n")
    .map((line) => line.trim().replace(/^[-*•\d.\s]+/, "").replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, "").trim())
    .filter(isKoreanLine);
  let s = lines.at(-1) ?? "";
  const firstSentence = s.match(/^.*?[.!?。](?=\s|$)/);
  if (firstSentence) s = firstSentence[0];
  const chars = [...s];
  return chars.length > MAX_LEN ? chars.slice(0, MAX_LEN).join("").trim() : s;
}

function isKoreanLine(line: string): boolean {
  const hangul = (line.match(/[가-힣]/g) ?? []).length;
  const latin = (line.match(/[A-Za-z]/g) ?? []).length;
  return hangul >= 5 && latin <= hangul / 3;
}

async function askModel(model: string, prompt: string, apiKey: string): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "너는 맛집 한줄평 작가야. 생각 과정 없이 최종 한줄평 한 문장만 한국어로 출력해." },
        { role: "user", content: prompt },
      ],
      reasoning: { exclude: true },
      max_tokens: 1000,
      temperature: 0.8,
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`${model}: HTTP ${res.status}`);
  const data = await res.json();
  const review = cleanReview(data?.choices?.[0]?.message?.content ?? "");
  if (!review) throw new Error(`${model}: empty response`);
  return review;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST만 지원해요." }, 405);

  let body: { name?: unknown; menu?: unknown; rating?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "잘못된 요청이에요." }, 400);
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const menu = typeof body.menu === "string" ? body.menu.trim() : "";
  const rating = Number(body.rating);
  if (!name || [...name].length > 30) return json({ error: "식당 이름은 1~30자여야 해요." }, 400);
  if ([...menu].length > 30) return json({ error: "메뉴는 30자 이하여야 해요." }, 400);
  const hasRating = Number.isInteger(rating) && rating >= 1 && rating <= 5;

  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) return json({ error: "AI 키가 설정되지 않았어요." }, 500);

  const prompt = [
    "다음 식당에 대한 한국어 한줄평을 써 줘.",
    `- 식당 이름: ${name}`,
    menu ? `- 메뉴: ${menu}` : "",
    hasRating ? `- 별점: 5점 만점에 ${rating}점 (별점에 어울리는 분위기로)` : "",
    "규칙: 한국어 한 문장, 공백 포함 40자 이내, 따옴표·설명·이모지 없이 문장만 출력.",
  ].filter(Boolean).join("\n");

  // 무료 모델은 자주 바쁘거나(429) 생각 과정만 보내므로, 다 실패하면 첫 모델을 한 번 더 시도
  const errors: string[] = [];
  for (const model of [...MODELS, MODELS[0]]) {
    try {
      const review = await askModel(model, prompt, apiKey);
      return json({ review, model });
    } catch (err) {
      errors.push(String(err));
    }
  }
  console.error("all models failed", errors);
  return json({ error: "추천을 가져오지 못했어요." }, 502);
});
