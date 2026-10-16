// AI 기능 두 가지를 함수 하나로 처리한다.
// 1) 한줄평 추천: { name, menu, rating } → { review } (한국어 한 문장, 40자 이내)
// 2) 사장님 답글: { mode: "reply", id } → 해당 기록의 owner_reply를 채우고 { reply } (60자 이내)
// OPENROUTER_API_KEY는 Supabase 프로젝트 Secrets에서 읽는다.
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const MODELS = [
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "google/gemma-4-26b-a4b-it:free",
  "google/gemma-4-31b-it:free",
];
const REVIEW_MAX = 40;
const REPLY_MAX = 60;

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
// (한 문장 모드면 첫 문장만 남기고) 따옴표·공백을 정리해 maxLen자로 자른다
function cleanText(text: string, maxLen: number, oneSentence: boolean): string {
  const lines = text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .split("\n")
    .map((line) => line.trim().replace(/^[-*•\d.\s]+/, "").replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, "").trim())
    .filter(isKoreanLine);
  let s = lines.at(-1) ?? "";
  if (oneSentence) {
    const firstSentence = s.match(/^.*?[.!?。](?=\s|$)/);
    if (firstSentence) s = firstSentence[0];
  }
  const chars = [...s];
  return chars.length > maxLen ? chars.slice(0, maxLen).join("").trim() : s;
}

function isKoreanLine(line: string): boolean {
  const hangul = (line.match(/[가-힣]/g) ?? []).length;
  const latin = (line.match(/[A-Za-z]/g) ?? []).length;
  return hangul >= 5 && latin <= hangul / 3;
}

async function askModel(model: string, system: string, prompt: string, apiKey: string): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
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
  return data?.choices?.[0]?.message?.content ?? "";
}

// 무료 모델은 자주 바쁘거나(429) 생각 과정만 보내므로, 다 실패하면 첫 모델을 한 번 더 시도
async function generate(system: string, prompt: string, clean: (text: string) => string): Promise<string | null> {
  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) throw new Error("OPENROUTER_API_KEY missing");
  const errors: string[] = [];
  for (const model of [...MODELS, MODELS[0]]) {
    try {
      const text = clean(await askModel(model, system, prompt, apiKey));
      if (text) return text;
      errors.push(`${model}: empty response`);
    } catch (err) {
      errors.push(String(err));
    }
  }
  console.error("all models failed", errors);
  return null;
}

async function suggestReview(body: Record<string, unknown>) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const menu = typeof body.menu === "string" ? body.menu.trim() : "";
  const rating = Number(body.rating);
  if (!name || [...name].length > 30) return json({ error: "식당 이름은 1~30자여야 해요." }, 400);
  if ([...menu].length > 30) return json({ error: "메뉴는 30자 이하여야 해요." }, 400);
  const hasRating = Number.isInteger(rating) && rating >= 1 && rating <= 5;

  const prompt = [
    "다음 식당에 대한 한국어 한줄평을 써 줘.",
    `- 식당 이름: ${name}`,
    menu ? `- 메뉴: ${menu}` : "",
    hasRating ? `- 별점: 5점 만점에 ${rating}점 (별점에 어울리는 분위기로)` : "",
    "규칙: 한국어 한 문장, 공백 포함 40자 이내, 따옴표·설명·이모지 없이 문장만 출력.",
  ].filter(Boolean).join("\n");

  const review = await generate(
    "너는 맛집 한줄평 작가야. 생각 과정 없이 최종 한줄평 한 문장만 한국어로 출력해.",
    prompt,
    (text) => cleanText(text, REVIEW_MAX, true),
  );
  return review ? json({ review }) : json({ error: "추천을 가져오지 못했어요." }, 502);
}

// 사용자는 owner_reply를 쓸 수 없으므로(RLS), service role로 비어 있을 때만 한 번 채운다
async function ownerReply(body: Record<string, unknown>) {
  const id = typeof body.id === "string" ? body.id : "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "잘못된 요청이에요." }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: row, error } = await admin
    .from("restaurants")
    .select("name, menu, rating, review, owner_reply")
    .eq("id", id)
    .maybeSingle();
  if (error) return json({ error: "기록을 불러오지 못했어요." }, 500);
  if (!row) return json({ error: "기록이 없어요." }, 404);
  if (row.owner_reply) return json({ reply: row.owner_reply });
  if (!row.review) return json({ error: "한줄평이 있어야 답글을 달 수 있어요." }, 400);

  const prompt = [
    "손님이 우리 식당에 남긴 리뷰에 사장님으로서 답글을 써 줘.",
    `- 식당 이름: ${row.name}`,
    row.menu ? `- 메뉴: ${row.menu}` : "",
    `- 별점: 5점 만점에 ${row.rating}점`,
    `- 손님 리뷰: ${row.review}`,
    "규칙: 한국어 존댓말, 따뜻하고 진심 어린 말투, 별점이 낮으면 사과와 개선 약속,",
    "한두 문장, 공백 포함 60자 이내, 따옴표·설명·이모지 없이 답글만 출력.",
  ].filter(Boolean).join("\n");

  const reply = await generate(
    "너는 동네 식당 사장님이야. 생각 과정 없이 손님 리뷰에 대한 최종 답글만 한국어로 출력해.",
    prompt,
    (text) => cleanText(text, REPLY_MAX, false),
  );
  if (!reply) return json({ error: "답글을 만들지 못했어요." }, 502);

  const { data: saved, error: saveError } = await admin
    .from("restaurants")
    .update({ owner_reply: reply })
    .eq("id", id)
    .is("owner_reply", null)
    .select("owner_reply")
    .maybeSingle();
  if (saveError) return json({ error: "답글을 저장하지 못했어요." }, 500);
  // 동시에 다른 요청이 먼저 채웠다면 그 답글을 돌려준다
  if (!saved) {
    const { data: current } = await admin.from("restaurants").select("owner_reply").eq("id", id).maybeSingle();
    return json({ reply: current?.owner_reply ?? reply });
  }
  return json({ reply: saved.owner_reply });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST만 지원해요." }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "잘못된 요청이에요." }, 400);
  }

  try {
    return body.mode === "reply" ? await ownerReply(body) : await suggestReview(body);
  } catch (err) {
    console.error(err);
    return json({ error: "AI 기능을 쓸 수 없어요." }, 500);
  }
});
