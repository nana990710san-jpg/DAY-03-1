// AI 기능 두 가지를 함수 하나로 처리한다.
// 1) 한줄평 추천: { name, menu, rating } → { review, others } (한국어 한 문장, 40자 이내)
//    others는 이 앱에 실제로 등록된 다른 사람들의 같은 메뉴·식당 한줄평(최대 3개)
// 2) 사장님 답글: { mode: "reply", id } → 해당 기록의 owner_reply를 채우고 { reply } (60자 이내)
// 두 기능 모두 이메일로 로그인한 회원의 토큰(Authorization)이 있어야 한다.
// OPENROUTER_API_KEY는 Supabase 프로젝트 Secrets에서 읽는다.
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

// 앞의 셋이 기본 모델, 뒤의 셋은 무료 모델이 자주 멈추거나 붐벼서 넣은 예비 모델
const MODELS = [
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "google/gemma-4-26b-a4b-it:free",
  "google/gemma-4-31b-it:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "nvidia/nemotron-3.5-lightning:free",
  "dots-studio/dots-3-note-preview:free",
];
// 모든 모델을 동시에 불러 가장 먼저 온 쓸 만한 답을 쓴다. 이 시간 안에 아무도 못 주면 실패
const TIMEOUT_MS = 20000;
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
  // 한글·영문·숫자·기본 문장부호 밖의 글자가 섞인 깨진 문장은 버린다
  if (/[^가-힣ㄱ-ㅣ\x20-\x7E…·“”‘’]/.test(line)) return false;
  const hangul = (line.match(/[가-힣]/g) ?? []).length;
  const latin = (line.match(/[A-Za-z]/g) ?? []).length;
  return hangul >= 5 && latin <= hangul / 3;
}

async function askModel(model: string, system: string, prompt: string, apiKey: string, signal: AbortSignal): Promise<string> {
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
    signal,
  });
  if (!res.ok) throw new Error(`${model}: HTTP ${res.status}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

// 무료 모델은 자주 멈추거나 바쁘거나(429) 생각 과정만 보내므로, 순서대로 기다리지 않고
// 모두 동시에 불러 처음 도착한 쓸 만한 답을 쓰고 나머지 요청은 끊는다
async function generate(system: string, prompt: string, clean: (text: string) => string): Promise<string | null> {
  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) throw new Error("OPENROUTER_API_KEY missing");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await Promise.any(MODELS.map(async (model) => {
      const text = clean(await askModel(model, system, prompt, apiKey, controller.signal));
      if (!text) throw new Error(`${model}: empty response`);
      console.log("answered by", model);
      return text;
    }));
  } catch (err) {
    console.error("all models failed", err instanceof AggregateError ? err.errors.map(String) : String(err));
    return null;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

// 모든 AI 문장에 공통으로 쓰는 말투
const FRIENDLY_TONE =
  "말투: 친한 친구한테 수다 떨듯 밝고 쾌활하게, 하지만 '~요'로 끝나는 존댓말로. 딱딱한 공문체·상투적인 표현은 빼고, 자연스러운 완전한 문장으로.";

function adminClient() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

type OtherReview = { name: string; menu: string | null; rating: number; review: string };

// 이 앱에 실제로 등록된 다른 사람들의 한줄평 중 같은 메뉴(비슷한 이름 포함)나 같은 식당 것을 모은다
async function findOtherReviews(name: string, menu: string): Promise<OtherReview[]> {
  const admin = adminClient();
  const columns = "id, name, menu, rating, review";
  const queries = [admin.from("restaurants").select(columns).eq("name", name).not("review", "is", null)];
  if (menu) {
    const pattern = `%${menu.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    queries.unshift(admin.from("restaurants").select(columns).ilike("menu", pattern).not("review", "is", null));
  }
  const results = await Promise.all(queries.map((q) => q.order("created_at", { ascending: false }).limit(5)));
  const seen = new Set<string>();
  const others: OtherReview[] = [];
  for (const { data } of results) {
    for (const row of data ?? []) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      others.push({ name: row.name, menu: row.menu, rating: row.rating, review: row.review });
    }
  }
  return others.slice(0, 3);
}

async function suggestReview(body: Record<string, unknown>) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const menu = typeof body.menu === "string" ? body.menu.trim() : "";
  const rating = Number(body.rating);
  if (!name || [...name].length > 30) return json({ error: "식당 이름은 1~30자여야 해요." }, 400);
  if ([...menu].length > 30) return json({ error: "메뉴는 30자 이하여야 해요." }, 400);
  const hasRating = Number.isInteger(rating) && rating >= 1 && rating <= 5;

  let others: OtherReview[] = [];
  try {
    others = await findOtherReviews(name, menu);
  } catch (err) {
    console.error("other reviews", err);
  }

  const prompt = [
    "내가 이 식당에 다녀와서 남길 한줄평을 대신 써 줘. 진짜 손님이 쓴 것처럼 생생하게.",
    `- 식당 이름: ${name}`,
    menu ? `- 메뉴: ${menu}` : "",
    hasRating ? `- 내 별점: 5점 만점에 ${rating}점 (별점에 어울리는 분위기로)` : "",
    others.length
      ? `- 참고할 다른 손님들의 실제 한줄평:\n${others.map((o) => `  · ${o.rating}점 "${o.review}"`).join("\n")}`
      : "",
    others.length ? "다른 손님 의견을 참고하되 그대로 베끼지 말고, 맛·양·분위기 중 하나를 구체적으로 짚어 줘." : "",
    FRIENDLY_TONE,
    "규칙: 한국어 완전한 한 문장, 공백 포함 40자 이내, 따옴표·설명·이모지 없이 문장만 출력.",
  ].filter(Boolean).join("\n");

  const review = await generate(
    "너는 맛집 다니기 좋아하는 밝고 수다스러운 친구야. 생각 과정 없이 최종 한줄평 한 문장만 한국어로 출력해.",
    prompt,
    (text) => cleanText(text, REVIEW_MAX, true),
  );
  return review ? json({ review, others }) : json({ error: "추천을 가져오지 못했어요.", others }, 502);
}

// 사용자는 owner_reply를 쓸 수 없으므로(RLS), service role로 비어 있을 때만 한 번 채운다
async function ownerReply(body: Record<string, unknown>) {
  const id = typeof body.id === "string" ? body.id : "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "잘못된 요청이에요." }, 400);

  const admin = adminClient();
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
    FRIENDLY_TONE,
    "리뷰 내용을 콕 집어 받아치기. 칭찬엔 신나게, 아쉬운 소리엔 너스레 섞어 사과하고 다음엔 잘하겠다고. 상투적인 인사(예: 소중한 리뷰 감사드립니다)는 쓰지 마.",
    "규칙: 한두 문장, 공백 포함 60자 이내, 따옴표·설명·이모지 없이 답글만 출력.",
  ].filter(Boolean).join("\n");

  const reply = await generate(
    "너는 손님과 친구처럼 지내는 밝고 쾌활한 동네 식당 사장님이야. 생각 과정 없이 손님 리뷰에 대한 최종 답글만 한국어로 출력해.",
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

  // AI 기능은 이메일로 로그인한 회원만 (익명 세션·비로그인은 거절)
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: auth } = token ? await adminClient().auth.getUser(token) : { data: { user: null } };
  if (!auth.user || auth.user.is_anonymous) return json({ error: "로그인해야 쓸 수 있어요." }, 401);

  try {
    return body.mode === "reply" ? await ownerReply(body) : await suggestReview(body);
  } catch (err) {
    console.error(err);
    return json({ error: "AI 기능을 쓸 수 없어요." }, 500);
  }
});
