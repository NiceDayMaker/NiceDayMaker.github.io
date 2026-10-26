/* 사이트 공용: 절 목록, 수식 렌더링, 목차 강조, 공부 완료 표시 */
(function () {
  "use strict";

  // 시험 범위 전체. 새 절 페이지를 만들면 href만 채우면 된다.
  const CHAPTERS = [
    { no: 9, title: "매개변수방정식과 극좌표", sections: [
      { id: "9.1", title: "매개변수방정식으로 정의된 곡선", href: "9-1.html" },
      { id: "9.2", title: "매개변수곡선에 대한 미적분", href: "9-2.html" },
      { id: "9.3", title: "극좌표", href: "9-3.html" },
      { id: "9.4", title: "극좌표에서 넓이와 길이", href: "9-4.html" },
    ] },
    { no: 10, title: "무한수열과 급수", sections: [
      { id: "10.6", title: "비판정법과 근판정법", href: "10-6.html" },
      { id: "10.7", title: "급수 판정을 위한 전략", href: "10-7.html" },
      { id: "10.8", title: "거듭제곱급수", href: "10-8.html" },
      { id: "10.9", title: "함수를 거듭제곱급수로 나타내기", href: "10-9.html" },
      { id: "10.10", title: "테일러 급수와 매클로린 급수", href: "10-10.html" },
    ] },
    { no: 11, title: "벡터와 공간기하학", sections: [
      { id: "11.3", title: "내적", href: "11-3.html" },
      { id: "11.4", title: "외적", href: "11-4.html" },
      { id: "11.5", title: "직선과 평면의 방정식", href: "11-5.html" },
    ] },
    { no: 12, title: "벡터함수", sections: [
      { id: "12.1", title: "벡터함수와 공간곡선", href: "12-1.html" },
      { id: "12.2", title: "벡터함수의 도함수와 적분", href: "12-2.html" },
      { id: "12.3", title: "호의 길이와 곡률", note: "예제 7까지", href: "12-3.html" },
    ] },
  ];
  const ALL = CHAPTERS.flatMap((c) => c.sections);

  // 화면 테마: 자동(기기 설정) → 라이트 → 다크
  const THEMES = ["auto", "light", "dark"];
  const THEME_LABEL = { auto: "자동", light: "라이트", dark: "다크" };
  const THEME_ICON = {
    auto: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 1.8a6.2 6.2 0 0 1 0 12.4z" fill="currentColor"/></svg>',
    light: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3.2" fill="currentColor"/><g stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 1v1.8M8 13.2V15M1 8h1.8M13.2 8H15M3 3l1.3 1.3M11.7 11.7 13 13M3 13l1.3-1.3M11.7 4.3 13 3"/></g></svg>',
    dark: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 10.2A6 6 0 0 1 5.8 2.5a6 6 0 1 0 7.7 7.7z" fill="currentColor"/></svg>',
  };
  function readTheme() { try { return localStorage.getItem("theme") || "auto"; } catch (e) { return "auto"; } }
  function saveTheme(t) { try { t === "auto" ? localStorage.removeItem("theme") : localStorage.setItem("theme", t); } catch (e) { /* 저장 못 해도 이번 화면엔 적용 */ } }
  function repaint() {
    window.dispatchEvent(new Event("themechange"));
    // 페이지마다 따로 그리는 머리 그림은 크기 변화로 다시 그리게 한다
    document.querySelectorAll("canvas#hero").forEach((cv) => {
      cv.style.width = "calc(100% - 1px)";
      requestAnimationFrame(() => { cv.style.width = ""; });
    });
  }
  function applyTheme(t) {
    if (t === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
  }
  function themeToggle() {
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "theme-toggle";
    const paint = () => {
      const t = readTheme(), next = THEMES[(THEMES.indexOf(t) + 1) % THEMES.length];
      btn.innerHTML = THEME_ICON[t] + "<span>" + THEME_LABEL[t] + "</span>";
      btn.setAttribute("aria-label", "화면 테마: " + THEME_LABEL[t] + " (누르면 " + THEME_LABEL[next] + ")");
      btn.title = btn.getAttribute("aria-label");
    };
    btn.addEventListener("click", () => {
      const t = readTheme(), next = THEMES[(THEMES.indexOf(t) + 1) % THEMES.length];
      saveTheme(next); applyTheme(next); paint(); repaint();
    });
    paint();
    document.body.appendChild(btn);
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (readTheme() === "auto") repaint(); });
  }
  applyTheme(readTheme());

  function renderMath() {
    if (!window.renderMathInElement) return;
    window.renderMathInElement(document.body, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "\\[", right: "\\]", display: true },
        { left: "$", right: "$", display: false },
        { left: "\\(", right: "\\)", display: false },
      ],
      ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code", "canvas"],
      throwOnError: false,
    });
  }

  function sideToc() {
    const links = [...document.querySelectorAll(".side ol a")];
    if (!links.length || !("IntersectionObserver" in window)) return;
    const map = new Map(links.map((a) => [a.getAttribute("href").slice(1), a]));
    const visible = new Set();
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => (e.isIntersecting ? visible.add(e.target.id) : visible.delete(e.target.id)));
      const ids = [...map.keys()];
      const current = ids.find((id) => visible.has(id));
      if (current) links.forEach((a) => a.classList.toggle("on", a === map.get(current)));
    }, { rootMargin: "0px 0px -65% 0px" });
    map.forEach((_, id) => { const el = document.getElementById(id); if (el) io.observe(el); });
  }

  function sectionPage() {
    const id = document.body.dataset.section;
    if (!id) return;
    // 이전 / 다음 절
    const pager = document.querySelector(".pager");
    if (pager) {
      const i = ALL.findIndex((s) => s.id === id);
      const cell = (s, cls, word) => {
        if (!s) return "";
        const inner = "<small>" + word + "</small>" + s.id + " " + s.title;
        return s.href
          ? '<a class="' + cls + '" href="' + s.href + '">' + inner + "</a>"
          : '<span class="' + cls + '">' + inner + "</span>";
      };
      pager.innerHTML = cell(ALL[i - 1], "prev", "이전 절") + cell(ALL[i + 1], "next", "다음 절");
    }
  }

  function indexPage() {
    const host = document.getElementById("chapters");
    if (!host) return;
    host.innerHTML = CHAPTERS.map((c) =>
      '<section class="chapter-block"><h2>' + c.no + "장 " + c.title + "</h2><ul class=\"sec-list\">" +
      c.sections.map((s) => {
        const note = s.note ? '<span class="note">' + s.note + "</span>" : "";
        const inner = '<span class="no">' + s.id + "</span><span>" + s.title + note + "</span>";
        return s.href
          ? '<li><a href="' + s.href + '">' + inner + "</a></li>"
          : '<li><div class="soon">' + inner + "</div></li>";
      }).join("") + "</ul></section>"
    ).join("");
  }

  document.addEventListener("DOMContentLoaded", () => {
    renderMath();
    sideToc();
    sectionPage();
    indexPage();
    themeToggle();
  });
  window.Site = { CHAPTERS: CHAPTERS };
})();
