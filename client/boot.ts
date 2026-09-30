// Progressive enhancement only: every page works without this file.
import { initAll } from "govuk-frontend";

initAll();

// ---------------------------------------------------------------- menu (as in loci)

const btn = document.getElementById("menu-toggle");
const panel = document.getElementById("menu-panel");
if (btn && panel) {
  const setOpen = (open: boolean) => {
    btn.setAttribute("aria-expanded", String(open));
    btn.classList.toggle("lg-header__menu--open", open);
    panel.hidden = !open;
  };
  btn.addEventListener("click", () => setOpen(!!panel.hidden));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) {
      setOpen(false);
      btn.focus();
    }
  });
}

// ---------------------------------------------------------------- task board

const board = document.querySelector<HTMLElement>("[data-board]");
if (board) {
  let dragged: HTMLElement | null = null;
  let origin: { list: HTMLElement; next: Element | null } | null = null;

  const lists = () => [...board.querySelectorAll<HTMLElement>("ol[data-status-id]")];
  const idsIn = (list: HTMLElement) => [...list.querySelectorAll<HTMLElement>(".lg-card")].map((c) => Number(c.dataset.id));

  const bump = (list: HTMLElement, by: number) => {
    const count = list.closest(".lg-column")?.querySelector(".lg-column__count");
    if (count) count.textContent = String(Number(count.textContent) + by);
  };

  /** The card the pointer is above, so the dragged card goes before it. */
  const cardAfter = (list: HTMLElement, y: number): Element | null => {
    for (const card of list.querySelectorAll<HTMLElement>(".lg-card:not(.lg-card--dragging)")) {
      const box = card.getBoundingClientRect();
      if (y < box.top + box.height / 2) return card;
    }
    return null;
  };

  board.addEventListener("dragstart", (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>(".lg-card");
    if (!card) return;
    dragged = card;
    origin = { list: card.parentElement as HTMLElement, next: card.nextElementSibling };
    card.classList.add("lg-card--dragging");
    e.dataTransfer?.setData("text/plain", card.dataset.id ?? "");
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  });

  board.addEventListener("dragover", (e) => {
    if (!dragged) return;
    const list = (e.target as HTMLElement).closest<HTMLElement>(".lg-column")?.querySelector<HTMLElement>("ol[data-status-id]");
    if (!list) return;
    e.preventDefault();
    const after = cardAfter(list, e.clientY);
    if (after !== dragged && (after !== dragged.nextElementSibling || dragged.parentElement !== list)) {
      list.insertBefore(dragged, after);
    }
    for (const l of lists()) l.classList.toggle("lg-column__list--over", l === list);
  });

  board.addEventListener("drop", (e) => e.preventDefault());

  board.addEventListener("dragend", async () => {
    const card = dragged;
    const from = origin;
    dragged = null;
    origin = null;
    for (const l of lists()) l.classList.remove("lg-column__list--over");
    if (!card || !from) return;
    card.classList.remove("lg-card--dragging");
    const list = card.parentElement as HTMLElement;
    if (list === from.list && card.nextElementSibling === from.next) return;

    const statusId = Number(list.dataset.statusId);
    if (list !== from.list) {
      bump(from.list, -1);
      bump(list, 1);
    }
    const select = card.querySelector<HTMLSelectElement>("select[name=status_id]");
    if (select) select.value = String(statusId);
    try {
      const res = await fetch(`/tasks/${card.dataset.id}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ status_id: statusId, order: idsIn(list) }),
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      // Put it back and let the server's view win.
      from.list.insertBefore(card, from.next);
      location.reload();
    }
  });
}

// ---------------------------------------------------------------- goals
//
// Ticking a goal posts in the background instead of reloading the page.
// Without JS each tick is an ordinary form post.

document.addEventListener("submit", async (e) => {
  const f = (e.target as HTMLElement).closest<HTMLFormElement>("form[data-goal-toggle]");
  if (!f) return;
  e.preventDefault();
  const input = f.querySelector<HTMLInputElement>("input[name=done]")!;
  const button = f.querySelector<HTMLButtonElement>("button")!;
  const body = new URLSearchParams();
  for (const [k, v] of new FormData(f)) if (typeof v === "string") body.append(k, v);
  const done = input.value === "1";

  f.closest(".lg-goal")?.classList.toggle("lg-goal--done", done);
  input.value = done ? "0" : "1";
  button.querySelector(".govuk-visually-hidden")!.textContent = `Mark ‘${button.dataset.title}’ as ${done ? "not done" : "done"}`;
  const list = f.closest("[data-goals]");
  const count = list?.parentElement?.querySelector("[data-goal-count]");
  if (list && count) {
    count.textContent = `${list.querySelectorAll(".lg-goal--done").length} of ${list.querySelectorAll(".lg-goal").length} done`;
  }

  try {
    const res = await fetch(f.action, { method: "POST", headers: { Accept: "application/json" }, body });
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    location.reload();
  }
});

// ---------------------------------------------------------------- popup
//
// Links marked data-modal (tasks, and the status and domain lists) open in a
// dialog instead of a new page. The server renders just the page's content
// when it sees the partial header. Forms inside post over fetch: a validation
// error re-renders in place, success shows the next page in the dialog, and
// the page behind reloads when the dialog closes. Without JS, the same links
// and forms work as ordinary pages.

const IN_MODAL = [/^\/tasks\/(new|\d+(\/(edit|delete))?)$/, /^\/goals\/\d+\/edit$/, /^\/settings\/(statuses|domains)(\/\d+)?$/];
const inModal = (url: URL) => url.origin === location.origin && IN_MODAL.some((re) => re.test(url.pathname));

const dialog = document.createElement("dialog");
dialog.className = "lg-dialog";
dialog.setAttribute("aria-labelledby", "lg-dialog-title");
dialog.innerHTML = `
  <div class="lg-dialog__bar">
    <span class="lg-dialog__title" id="lg-dialog-title"></span>
    <button type="button" class="lg-link-button lg-dialog__close">Close</button>
  </div>
  <div class="lg-dialog__body"></div>`;
document.body.append(dialog);
const dialogBody = dialog.querySelector<HTMLElement>(".lg-dialog__body")!;
const dialogTitle = dialog.querySelector<HTMLElement>(".lg-dialog__title")!;
let changed = false;

async function openModal(url: string, init: RequestInit = {}): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { ...init.headers, "X-Ledger-Partial": "1" } });
  } catch {
    location.href = url;
    return;
  }
  if (res.status === 401 || new URL(res.url).pathname === "/login") {
    location.href = "/login";
    return;
  }
  if (init.method === "POST" && res.ok) changed = true;
  // Finished somewhere that is not a popup page (a delete back to the board).
  if (res.redirected && !inModal(new URL(res.url))) {
    location.reload();
    return;
  }
  dialogBody.innerHTML = await res.text();
  const partial = dialogBody.querySelector<HTMLElement>(".lg-partial");
  dialogTitle.textContent = partial?.dataset.title ?? "";
  initAll({ scope: dialogBody });
  if (!dialog.open) dialog.showModal();
  const focusTarget = dialogBody.querySelector<HTMLElement>(".govuk-error-summary, .govuk-notification-banner, h1");
  if (focusTarget) {
    focusTarget.tabIndex = -1;
    focusTarget.focus();
  }
  dialogBody.scrollTop = 0;
}

document.addEventListener("click", (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[href]");
  if (!a) return;
  const url = new URL(a.href);
  if (dialog.contains(a)) {
    if (a.hasAttribute("data-close") || url.pathname === "/tasks/board" || url.pathname === "/tasks") {
      e.preventDefault();
      dialog.close();
    } else if (inModal(url)) {
      e.preventDefault();
      void openModal(url.href);
    }
    return;
  }
  if (a.hasAttribute("data-modal") && inModal(url)) {
    e.preventDefault();
    void openModal(url.href);
  }
});

dialog.addEventListener("submit", (e) => {
  const f = e.target as HTMLFormElement;
  if (f.method.toLowerCase() !== "post") return;
  e.preventDefault();
  const body = new URLSearchParams();
  for (const [k, v] of new FormData(f, (e as SubmitEvent).submitter)) if (typeof v === "string") body.append(k, v);
  void openModal(f.action, { method: "POST", body });
});

dialog.querySelector(".lg-dialog__close")!.addEventListener("click", () => dialog.close());
// A click on the backdrop lands on the dialog element itself.
dialog.addEventListener("click", (e) => {
  if (e.target === dialog) dialog.close();
});
dialog.addEventListener("close", () => {
  dialogBody.innerHTML = "";
  if (changed) location.reload();
});
