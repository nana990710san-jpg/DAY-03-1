# STEPS — 만들 순서

자세한 요구사항은 [PRD.md](PRD.md)를 따른다. 각 단계는 끝날 때 동작을 확인하고 커밋한 뒤 다음으로 넘어간다.

---

## 1단계. 맛집 기록 (index.html + localStorage)

**목표:** 내 브라우저 안에서 맛집을 추가·삭제하고, 새로고침해도 남게 한다.

1. `index.html` 한 파일 만들기 (npm 없음)
   - 상단 제목, 입력 폼(식당 이름 / 메뉴 / 별점 1~5 / 한줄평 / [추가]), 하단 카드 목록 영역
2. 디자인 적용
   - 흰 카드 + 둥근 모서리 + 옅은 그림자, 주황색 포인트(`#FF6600`)
   - 최대 폭 640px 가운데 정렬, 휴대폰 폭(360px)에서 깨지지 않게
3. 입력 검증
   - 이름 필수·30자 이하, 메뉴 30자 이하, 별점 필수 1~5, 한줄평 100자 이하 (`maxlength` + JS 검사)
4. 저장 로직
   - `localStorage`의 `restaurants` 키에 배열로 저장
   - 각 기록: `id`(`crypto.randomUUID()`), `name`, `menu`, `rating`, `review`, `created_at`
5. 목록 표시
   - `created_at` 최신순, 맨 위에 새 기록, 빈 목록 안내 문구
6. [삭제] 버튼
   - 확인 창 후 삭제하고 목록 다시 그리기

**확인:** 추가 → 새로고침 → 그대로 있음 / 삭제 → 새로고침 → 사라짐 / 휴대폰 폭에서 보기 좋음

---

## 2단계. Supabase 저장

**목표:** 여러 사람이 같은 목록을 함께 보게 한다.

1. Supabase에 새 표 `restaurants` 만들기 (SQL)
   - `id uuid primary key default gen_random_uuid()`
   - `name text not null`, `menu text`, `rating smallint not null`, `review text`
   - `created_at timestamptz not null default now()`
   - `user_id uuid not null default auth.uid()` (올린 사람)
   - CHECK 제약: 이름 1~30자, 메뉴 30자 이하, 별점 1~5, 한줄평 100자 이하
2. Supabase Authentication 설정에서 **Anonymous sign-ins 켜기**
3. RLS 켜기 + `authenticated` 정책 3개 (update 정책은 만들지 않음)
   - select: 모두 허용
   - insert: `with check (user_id = auth.uid())`
   - delete: `using (user_id = auth.uid())` — 자기가 올린 것만
4. `index.html`에 `supabase-js`를 CDN으로 불러오고, 프로젝트 URL과 **anon(publishable) 키**로 연결
   - 페이지를 열 때 세션이 없으면 `signInAnonymously()` 호출
5. 저장 로직을 localStorage → Supabase로 교체
   - 목록: `select * order by created_at desc`
   - 추가: `insert` 후 목록 새로고침 (`user_id`는 표 기본값으로 자동)
   - 삭제: `delete where id = …` 후 목록 새로고침
   - [삭제] 버튼은 `user_id`가 내 익명 사용자 id와 같은 카드에만 표시
6. 오류 처리: 실패 시 안내 문구 표시

**확인:** 두 브라우저(또는 PC·휴대폰)에서 같은 목록이 보임 / 내 카드에만 [삭제]가 보임 / 다른 브라우저에서 올린 기록은 API로 지우려 해도 안 지워짐 / SQL로 31자 이름·별점 6을 넣으면 거부됨 / update는 거부됨

---

## 3단계. AI 한줄평

**목표:** 버튼 하나로 40자 이내 한국어 한줄평을 추천받는다.

1. Edge Function `suggest-review` 1개 만들기, **`verify_jwt` 끔**
2. 함수 내용
   - `OPTIONS` 요청에 CORS 헤더로 응답
   - 입력 `{ name, menu, rating }` 검증 (이름 필수·길이 규칙)
   - `Deno.env.get("OPENROUTER_API_KEY")`로 키 읽기 (Secrets에 이미 있음, 코드에 넣지 않기)
   - OpenRouter 호출:
     `nvidia/nemotron-3-ultra-550b-a55b:free`, `google/gemma-4-26b-a4b-it:free`, `google/gemma-4-31b-it:free` + 예비 무료 모델 3개를 동시에 불러 처음 온 쓸 만한 답 사용(20초 제한)
   - 응답 정리: 따옴표·공백 제거, 첫 문장만, 40자 초과 시 자르기
   - 같은 메뉴·식당의 실제 한줄평(최대 3개)을 `others`로 함께 돌려주고, 화면에 "다른 고객님들의 의견이에요!" 창으로 표시
   - `{ review }` 반환
3. 배포 후 curl로 함수 단독 테스트
4. `index.html`에 [AI 추천] 버튼 연결
   - 이름이 비었으면 안내, 요청 중 버튼 비활성화 + "추천 중…"
   - 결과를 한줄평 칸에 채우기, 실패 시 안내

**확인:** 버튼 → 40자 이내 한국어 한 문장이 채워짐 / 저장소에 키 문자열이 없음

### 3-2. AI 사장님 답글 (추가 기능)

1. 표에 `owner_reply text` 칸 추가 (100자 이하 CHECK), 추가(insert) 정책에 `owner_reply is null` 조건 추가
2. 같은 함수 `suggest-review`에 `{ mode: "reply", id }` 모드 추가
   - service role로 기록을 읽어 60자 이내의 쾌활한 존댓말 답글 생성, `owner_reply`가 비어 있을 때만 저장
3. `index.html`
   - 한줄평이 있는 기록을 추가하면 자동으로 답글 요청, 그동안 "사장님이 답글을 쓰는 중…"
   - 카드 한줄평 아래에 "사장님 답글" 표시
   - 실패하면 내 카드에 [사장님 답글 받기] 버튼

**확인:** 한줄평을 넣고 추가 → 잠시 뒤 답글이 달림 / 다른 브라우저에서도 같은 답글이 보임 / 사용자가 API로 `owner_reply`를 직접 쓰면 거부됨

### 3-3. 위치와 맛집 지도 (추가 기능)

1. 표에 `lat`·`lng`(선택) 칸 추가, 둘 다 비었거나 올바른 범위일 때만 받는 CHECK
2. `index.html`에 Leaflet(cdnjs) + OpenStreetMap 지도 두 개
   - 입력 폼: 지도를 눌러 위치 찍기, [📍 내 위치로], [위치 지우기]
   - "맛집 지도": 위치가 있는 모든 기록을 주황 핀으로, 핀을 누르면 이름·별점·메뉴·한줄평
   - 카드: 위치가 있으면 [📍 지도에서 보기]

**확인:** 위치를 찍고 추가 → 맛집 지도에 핀이 생김 / [지도에서 보기]로 그 핀이 열림 / 위도 95 같은 값은 표에서 거부됨 / 휴대폰 폭에서 가로 스크롤 없음

---

## 4단계. 배포 (GitHub → Vercel)

**목표:** 공개 URL로 누구나 휴대폰에서 쓸 수 있게 한다.

1. 키 점검: 코드에 anon 키 외의 비밀 키(OpenRouter, service_role)가 없는지 확인
2. GitHub 저장소 만들고 push (`index.html`, `PRD.md`, `STEPS.md`, Edge Function 코드)
3. Vercel에서 저장소 가져오기 → 프레임워크 없음(정적), 빌드 명령 없음
4. 배포된 URL에서 전체 기능 점검

**확인:** 휴대폰으로 배포 URL 접속 → 추가·삭제·AI 추천·AI 사장님 답글 모두 동작, 다른 기기에서도 같은 목록
