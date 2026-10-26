/* 자가 점검 퀴즈 — 모든 절에서 공용으로 사용
 *
 * Quiz.mount(hostEl, [
 *   {
 *     q: "문제 (HTML, $수식$ 가능)",
 *     choices: ["보기1", "보기2", ...],
 *     answer: 1,                    // 정답 보기 번호 (0부터)
 *     explain: "풀이 (HTML)",
 *     plot: { ...Plot.mount 옵션 },  // 선택: 답을 고른 뒤 그래프로 확인
 *     plotWidth: "22rem"            // 선택: 그래프 최대 너비
 *   }, ...
 * ])
 *
 * 문제 DOM은 즉시 만들어지므로 site.js의 수식 렌더링이 그대로 적용된다.
 */
(function () {
  "use strict";
  const LETTERS = "ABCDEFG";
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function mount(host, items) {
    host.classList.add("quiz");
    let answered = 0, right = 0;
    const cards = [];

    items.forEach((it, qi) => {
      const card = document.createElement("div");
      card.className = "q-card";
      card.innerHTML =
        '<p class="q-text"><span class="q-no">Q' + (qi + 1) + ".</span> " + it.q + "</p>" +
        '<div class="q-choices" role="group" aria-label="Q' + (qi + 1) + ' 보기">' +
        it.choices.map((c, ci) =>
          '<button type="button" class="q-choice" data-i="' + ci + '">' +
          '<span class="q-mark" aria-hidden="true">' + LETTERS[ci] + "</span><span class=\"q-label\">" + c + "</span></button>"
        ).join("") +
        "</div>" +
        '<div class="q-result" hidden>' +
        '<p class="q-verdict" role="status"></p>' +
        '<div class="q-explain">' + it.explain + "</div>" +
        (it.plot ? '<figure class="plot q-plot"' + (it.plotWidth ? ' style="max-width:' + it.plotWidth + '"' : "") + "></figure>" : "") +
        "</div>";
      host.appendChild(card);

      const buttons = [...card.querySelectorAll(".q-choice")];
      const result = card.querySelector(".q-result");
      const verdict = card.querySelector(".q-verdict");
      const fig = card.querySelector(".q-plot");
      const state = { done: false, plotApi: null };

      buttons.forEach((b) => b.addEventListener("click", () => {
        if (state.done) return;
        state.done = true;
        const pick = +b.dataset.i;
        const ok = pick === it.answer;
        buttons.forEach((o, oi) => {
          o.disabled = true;
          if (oi === it.answer) o.classList.add("is-right");
          else if (oi === pick) o.classList.add("is-wrong");
          else o.classList.add("is-dim");
        });
        card.classList.add(ok ? "got-right" : "got-wrong");
        verdict.textContent = ok ? "정답이에요." : "아쉬워요. 정답은 " + LETTERS[it.answer] + "예요.";
        result.hidden = false;
        if (fig) {
          if (!state.plotApi) state.plotApi = Plot.mount(fig, it.plot);
          else state.plotApi.setT(it.plot.t.min);
          if (!reduceMotion) state.plotApi.play();
        }
        answered++; if (ok) right++;
        updateScore();
      }));

      cards.push({
        reset() {
          state.done = false;
          buttons.forEach((o) => { o.disabled = false; o.classList.remove("is-right", "is-wrong", "is-dim"); });
          card.classList.remove("got-right", "got-wrong");
          verdict.textContent = "";
          result.hidden = true;
          if (state.plotApi) state.plotApi.pause();
        },
      });
    });

    const foot = document.createElement("div");
    foot.className = "q-foot";
    foot.innerHTML = '<p class="q-score" aria-live="polite"></p><button type="button" class="q-reset">처음부터 다시 풀기</button>';
    host.appendChild(foot);
    const score = foot.querySelector(".q-score");
    const resetBtn = foot.querySelector(".q-reset");

    function updateScore() {
      const n = items.length;
      if (answered === 0) score.textContent = "보기를 고르면 바로 정답과 풀이가 나와요.";
      else if (answered < n) score.textContent = "지금까지 " + answered + "문제 중 " + right + "문제 맞혔어요. " + (n - answered) + "문제 남았어요.";
      else score.textContent = n + "문제 중 " + right + "문제 맞혔어요." + (right === n ? " 전부 맞혔어요." : " 틀린 문제는 풀이를 다시 읽어 보세요.");
      resetBtn.hidden = answered === 0;
    }
    resetBtn.addEventListener("click", () => {
      answered = 0; right = 0;
      cards.forEach((c) => c.reset());
      updateScore();
      host.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    });
    updateScore();
  }

  window.Quiz = { mount: mount };
})();
