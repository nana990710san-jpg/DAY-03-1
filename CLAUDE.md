# CLAUDE.md

이 파일은 이 저장소에서 작업하는 Claude Code(claude.ai/code)에게 안내를 제공합니다.

## 프로젝트 상태

1~3단계가 끝났습니다(`index.html`, `supabase/functions/suggest-review/index.ts`). [PRD.md](PRD.md)(요구사항)와 [STEPS.md](STEPS.md)(만들 순서)가 기준이므로, 무엇이든 바꾸기 전에 먼저 읽으세요. 화면에 보이는 글자는 한국어로 씁니다.

앱 이름은 "우리 동네 숨은 맛집"이며, 동네 맛집을 기록하고 함께 보는 한 페이지짜리 웹앱입니다.

## 만들 순서

STEPS.md의 4단계를 순서대로 만듭니다. 각 단계를 끝내고 확인한 뒤 다음 단계로 넘어가세요.

1. `index.html` + `localStorage`
2. Supabase 표 `restaurants`
3. AI 한줄평 Edge Function
4. GitHub → Vercel 배포

## 구조 규칙

- **파일 하나로 된 화면:** HTML·CSS·JS를 모두 `index.html` 하나에 넣습니다. npm, 번들러, 빌드 단계는 없습니다. `supabase-js` 같은 라이브러리는 CDN `<script>` 태그로 불러옵니다.
- **데이터:** 2단계부터는 `localStorage` 대신 `restaurants` 표에 저장합니다. 글자 수와 별점 범위는 두 곳에서 막습니다. 화면에서는 `maxlength`와 JS 검사로, 표에서는 CHECK 제약으로 막으며, 두 쪽 규칙을 똑같이 맞춥니다(이름 1~30자, 메뉴 30자 이하, 별점 1~5, 한줄평 100자 이하).
- **로그인 없이 내 기록 구분하기:**
  - 페이지를 열면 Supabase 익명 로그인(`signInAnonymously()`)을 화면에 보이지 않게 호출합니다. 로그인 화면은 없습니다.
  - `user_id`는 기본값이 `auth.uid()`입니다.
  - RLS: 보기는 누구나, 추가는 `user_id = auth.uid()`일 때만, 삭제는 자기가 올린 기록만 할 수 있습니다.
  - 수정(update) 정책은 일부러 만들지 않아서 수정은 불가능합니다.
  - [삭제] 버튼은 내가 올린 카드에만 보여 줍니다.
- **AI 한줄평:**
  - Edge Function은 `suggest-review` 하나이며, `verify_jwt`를 끕니다. `{ name, menu, rating }`를 받아 `{ review }`를 돌려줍니다.
  - `review`는 40자 이내의 한국어 한 문장입니다. 모델 응답이 길면 함수에서 잘라 맞춥니다.
  - 함수는 Supabase Secrets에 있는 `OPENROUTER_API_KEY`를 `Deno.env.get`으로 읽습니다.
  - 모델은 `nvidia/nemotron-3-ultra-550b-a55b:free` → `google/gemma-4-26b-a4b-it:free` → `google/gemma-4-31b-it:free` 순서로 시도합니다.
  - CORS `OPTIONS` 요청에 응답해야 합니다.
- **AI 사장님 답글:**
  - 새 함수를 만들지 않고 `suggest-review`에 `{ mode: "reply", id }` 모드로 넣었습니다. 결과는 60자 이내 존댓말 답글입니다.
  - 답글은 `owner_reply` 칸에 저장합니다. 사용자는 이 칸을 쓸 수 없고(추가 정책에 `owner_reply is null`, 수정 권한 없음), 함수가 service role로 비어 있을 때만 한 번 채웁니다.
  - 화면은 한줄평이 있는 기록을 추가하면 자동으로 답글을 요청합니다. 실패하면 글쓴이 카드에 [AI 사장님 답글 받기] 버튼이 남습니다.
- **화면 코드에 넣는 키:** 화면 코드에는 Supabase URL과 anon(publishable) 키만 넣습니다.

## 하지 않을 것

로그인 화면, 기록 수정, 사진 업로드, 검색 기능은 만들지 않습니다.

## 명령어

- **1~3단계:** 브라우저에서 `index.html`을 바로 엽니다. 빌드·린트·테스트할 것은 없습니다.
- **Edge Function 배포** (Supabase CLI):

  ```bash
  supabase functions deploy suggest-review --no-verify-jwt
  ```

- **4단계 배포:** Vercel이 저장소를 정적 사이트로 내보냅니다. 프레임워크와 빌드 명령은 없습니다.
