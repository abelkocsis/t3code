/**
 * The overlay window's whole document, served as a data URL.
 *
 * Deliberately plain HTML rather than the web app: the overlay must not open a
 * second websocket connection or mount a second React tree just to draw a list
 * the main renderer already computed. It receives finished text over IPC and
 * draws it. The CSP allows no network of any kind.
 */
export const buildOverlayDataUrl = (): string => {
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
    >
    <meta name="color-scheme" content="dark">
    <style>
      :root {
        --bg: rgba(20, 20, 22, 0.95);
        --fg: #f0f0f0;
        --muted: #8a8a8a;
        --border: rgba(255, 255, 255, 0.09);
        --amber: #fcd34d;
        --indigo: #a5b4fc;
        --emerald: #34d399;
        --red: #f87171;
        --sky: #7dd3fc;
      }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      html, body { overflow: hidden; background: transparent; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        color: var(--fg);
        -webkit-font-smoothing: antialiased;
        user-select: none;
        cursor: default;
      }
      #full { display: flex; flex-direction: column; min-height: 0; }
      #full.hidden { display: none; }
      #shell {
        background: var(--bg);
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 14px;
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }
      header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 12px;
        border-bottom: 1px solid var(--border);
        -webkit-app-region: drag;
        flex: none;
      }
      header .logo {
        width: 16px; height: 16px; border-radius: 5px; background: #4f74e3;
        display: flex; align-items: center; justify-content: center;
        font-size: 8px; font-weight: 700; flex: none;
      }
      header .label { font-size: 11.5px; font-weight: 600; color: #c8c8c8; }
      header .more {
        margin-left: auto; color: var(--muted); font-size: 15px; line-height: 1;
        padding: 2px 6px; border-radius: 6px; -webkit-app-region: no-drag;
      }
      header .more:hover { background: rgba(255, 255, 255, 0.09); color: var(--fg); }
      #summary { padding: 12px 12px 2px; }
      #summary .count { font-size: 24px; font-weight: 600; letter-spacing: -0.02em; }
      #summary .count em { color: var(--amber); font-style: normal; font-size: 29px; }
      #summary .sub { font-size: 11.5px; color: var(--muted); margin-top: 3px; }
      #items {
        padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 7px;
        overflow-y: auto; max-height: 320px;
      }
      #items::-webkit-scrollbar { width: 6px; }
      #items::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.14); border-radius: 3px; }
      #items::-webkit-scrollbar-track { background: transparent; }
      .item {
        display: flex; align-items: center; gap: 9px;
        border: 1px solid var(--border); border-radius: 9px;
        padding: 8px 10px; background: rgba(255, 255, 255, 0.035);
      }
      .item:hover { background: rgba(255, 255, 255, 0.08); }
      .item .bar { width: 3px; align-self: stretch; border-radius: 2px; flex: none; }
      .item .text { flex: 1; min-width: 0; }
      .item .title {
        font-size: 12.5px; font-weight: 500;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .item .project { font-size: 10.5px; color: var(--muted); margin-top: 2px; }
      .item .phase { font-size: 10.5px; font-weight: 700; white-space: nowrap; }
      .waiting_for_approval { color: var(--amber); }
      .waiting_for_input { color: var(--indigo); }
      .completed { color: var(--emerald); }
      .failed { color: var(--red); }
      .bar.waiting_for_approval { background: var(--amber); }
      .bar.waiting_for_input { background: var(--indigo); }
      .bar.completed { background: var(--emerald); }
      .bar.failed { background: var(--red); }
      #pill {
        display: flex; align-items: center; gap: 9px;
        padding: 12px 10px 12px 14px; font-size: 12px; color: #c8c8c8;
        -webkit-app-region: drag;
      }
      #pill .more {
        margin-left: auto; color: var(--muted); font-size: 15px; line-height: 1;
        padding: 2px 6px; border-radius: 6px; -webkit-app-region: no-drag;
      }
      #pill .more:hover { background: rgba(255, 255, 255, 0.09); color: var(--fg); }
      #pill .working { color: var(--sky); font-weight: 600; }
      #menu {
        position: absolute; top: 38px; right: 10px; width: 214px; z-index: 10;
        background: rgba(38, 38, 40, 0.98); border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 10px; padding: 5px; display: none;
      }
      #menu.open { display: block; }
      #menu .head {
        font-size: 10px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase;
        color: var(--muted); padding: 8px 9px 5px;
      }
      #menu .row {
        display: flex; align-items: center; font-size: 12.5px; color: #dcdcdc;
        padding: 7px 9px; border-radius: 6px;
      }
      #menu .row:hover { background: rgba(255, 255, 255, 0.09); }
      #menu .row .when { margin-left: auto; font-size: 11px; color: var(--muted); }
      #menu .sep { height: 1px; background: rgba(255, 255, 255, 0.09); margin: 4px 6px; }
      .hidden { display: none !important; }
    </style>
  </head>
  <body>
    <div id="shell">
      <div id="pill" class="hidden">
        <span class="working" id="pill-working"></span>
        <span id="pill-rest"></span>
        <span class="more" id="pill-more">&#8943;</span>
      </div>
      <div id="full" class="hidden">
        <header>
          <span class="logo">T3</span>
          <span class="label">T3 Code</span>
          <span class="more" id="more">&#8943;</span>
        </header>
        <div id="summary">
          <div class="count"><em id="count">0</em> new</div>
          <div class="sub" id="working"></div>
        </div>
        <div id="items"></div>
      </div>
      <div id="menu">
        <div class="head">Hide the overlay</div>
        <div class="row" data-hide="hour">For 1 hour</div>
        <div class="row" data-hide="tomorrow">Until tomorrow</div>
        <div class="row" data-hide="indefinitely">Until I turn it back on</div>
        <div class="sep"></div>
        <div class="row" data-settings="1">Notification settings…</div>
      </div>
    </div>
    <script>
      (function () {
        var bridge = window.t3Overlay;
        var pill = document.getElementById("pill");
        var full = document.getElementById("full");
        var menu = document.getElementById("menu");
        var items = document.getElementById("items");

        function labelFor(phase) {
          return phase.replace(/_/g, " ");
        }

        function render(state) {
          var isPill = state.mode === "pill";
          pill.classList.toggle("hidden", !isPill);
          full.classList.toggle("hidden", isPill);
          if (isPill) {
            document.getElementById("pill-working").textContent =
              state.workingCount > 0 ? state.workingCount + " working" : "";
            document.getElementById("pill-rest").textContent =
              state.workingCount > 0 ? "\\u00b7 nothing needs you" : "Nothing needs you";
            reportHeight();
            return;
          }
          document.getElementById("count").textContent = String(state.items.length);
          document.getElementById("working").textContent =
            state.workingCount > 0 ? state.workingCount + " still working" : "Nothing else running";
          items.replaceChildren();
          state.items.forEach(function (item) {
            var row = document.createElement("div");
            row.className = "item";
            var bar = document.createElement("div");
            bar.className = "bar " + item.phase;
            var text = document.createElement("div");
            text.className = "text";
            var title = document.createElement("div");
            title.className = "title";
            title.textContent = item.threadTitle;
            text.appendChild(title);
            if (item.projectTitle) {
              var project = document.createElement("div");
              project.className = "project";
              project.textContent = item.projectTitle;
              text.appendChild(project);
            }
            var phase = document.createElement("div");
            phase.className = "phase " + item.phase;
            phase.textContent = item.phaseLabel || labelFor(item.phase);
            row.append(bar, text, phase);
            row.addEventListener("click", function () {
              bridge.send({
                kind: "open-thread",
                environmentId: item.environmentId,
                threadId: item.threadId,
              });
            });
            items.appendChild(row);
          });
          reportHeight();
        }

        // The window is sized to whatever the document actually needs, so a
        // single row never gets a scrollbar and a long list never gets cut off.
        var lastReportedHeight = 0;
        function reportHeight() {
          requestAnimationFrame(function () {
            var height = Math.ceil(document.getElementById("shell").getBoundingClientRect().height);
            if (height <= 0 || height === lastReportedHeight) return;
            lastReportedHeight = height;
            bridge.reportHeight(height);
          });
        }

        function toggleMenu(event) {
          event.stopPropagation();
          menu.classList.toggle("open");
          reportHeight();
        }
        document.getElementById("more").addEventListener("click", toggleMenu);
        // The pill needs the menu as much as the full card does: with nothing
        // waiting there is no other way to send the overlay away.
        document.getElementById("pill-more").addEventListener("click", toggleMenu);
        document.body.addEventListener("click", function () {
          menu.classList.remove("open");
        });
        menu.addEventListener("click", function (event) {
          var target = event.target.closest("[data-hide], [data-settings]");
          if (!target) return;
          menu.classList.remove("open");
          if (target.dataset.settings) {
            bridge.send({ kind: "open-settings" });
            return;
          }
          bridge.send({ kind: "hide", duration: target.dataset.hide });
        });

        bridge.onState(render);
        window.addEventListener("resize", reportHeight);
      })();
    </script>
  </body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
};

export const OVERLAY_WIDTH = 340;
/** Enough for the pill until the page reports what it actually needs. */
export const OVERLAY_INITIAL_HEIGHT = 44;
const OVERLAY_MIN_HEIGHT = 36;
const OVERLAY_MAX_HEIGHT = 520;

/**
 * Keeps a reported height sane. The page measures itself, so this only guards
 * against a zero during a reflow and against a list long enough to cover the
 * screen; the max is above the list's own scroll limit, so it never truncates
 * content that would otherwise fit.
 */
export function clampOverlayHeight(height: number): number {
  if (!Number.isFinite(height)) return OVERLAY_INITIAL_HEIGHT;
  return Math.min(OVERLAY_MAX_HEIGHT, Math.max(OVERLAY_MIN_HEIGHT, Math.ceil(height)));
}
