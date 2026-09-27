import { Hono } from "hono";
import type { FC } from "hono/jsx";
import { listCategories } from "../categories.ts";
import { db, localDate } from "../db.ts";
import { listPlaces, visitMs, visits } from "../places.ts";
import { listTasks } from "../tasks.ts";
import { ButtonLink, fmtDate, fmtDay, fmtTime, Tag } from "../views/components.tsx";
import { type Env, page } from "../web.tsx";

export const todayRoutes = new Hono<Env>();

function greeting(d = new Date()): string {
  const h = d.getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** "12h 30m", compact enough for a headline number. */
function fmtHours(ms: number): string {
  const mins = Math.round(ms / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

function startOfWeek(d = new Date()): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
}

/** One headline number that links to the detail behind it. */
const Stat: FC<{ label: string; value: string | number; href: string; note?: string; alert?: string }> = ({
  label,
  value,
  href,
  note,
  alert,
}) => (
  <a class={`lg-stat${alert ? " lg-stat--alert" : ""}`} href={href}>
    <span class="lg-stat__label">{label}</span>
    <span class="lg-stat__value">{value}</span>
    {alert ? <Tag colour="red">{alert}</Tag> : note && <span class="lg-stat__note">{note}</span>}
  </a>
);

todayRoutes.get("/", (c) => {
  const user = c.get("user");
  const now = new Date();
  const today = localDate(now);
  const places = listPlaces(user.id);
  const here = places.filter((p) => p.here_since);
  const open = listTasks(user.id, { status: "open" });
  const dueSoon = listTasks(user.id, { status: "open", due: "week" });
  const overdue = dueSoon.filter((t) => t.due_by! < today);
  const statuses = listCategories("statuses", user.id).filter((s) => !s.is_closed);
  const entries = db()
    .prepare("SELECT id, title FROM journal_entries WHERE user_id = ? AND entry_date = ? AND deleted_at IS NULL ORDER BY created_at")
    .all(user.id, today) as { id: number; title: string }[];
  const weekFrom = startOfWeek(now).toISOString();
  const weekTo = now.toISOString();
  const weekMs = visits(user.id, { from: weekFrom, to: weekTo }).reduce((sum, v) => sum + visitMs(v, weekFrom, weekTo), 0);

  const hero = (
    <div class="lg-masthead">
      <div class="govuk-width-container">
        <p class="lg-masthead__date">{fmtDay(today)}</p>
        <h1 class="lg-masthead__title">
          {greeting(now)}, {user.username}
        </h1>
        {places.length > 0 && (
          <p class="lg-masthead__lede">
            {here.length ? (
              <>
                You are at <strong>{here.map((p) => p.name).join(" and ")}</strong>, since {fmtTime(here[0].here_since!)}.
              </>
            ) : (
              "You are not at any of your places."
            )}
          </p>
        )}
        <div class="govuk-button-group">
          <a href="/journal/new" role="button" draggable={false} class="govuk-button govuk-button--inverse" data-module="govuk-button">
            Write in journal
          </a>
          <a href="/tasks/new" role="button" draggable={false} class="govuk-button govuk-button--inverse" data-module="govuk-button" data-modal>
            Add a task
          </a>
        </div>
      </div>
    </div>
  );

  return page(
    c,
    { title: "Today", nav: "today", hero },
    <>
      <h2 class="govuk-visually-hidden">At a glance</h2>
      <div class="lg-stats">
        <Stat label="Due in the next 7 days" value={dueSoon.length} href="/tasks?due=week" note="Open tasks with a due date" />
        <Stat
          label="Overdue"
          value={overdue.length}
          href="/tasks?due=overdue"
          alert={overdue.length ? "Needs attention" : undefined}
          note="Nothing overdue"
        />
        <Stat label="Open tasks" value={open.length} href="/tasks/board" note={`Across ${statuses.length} open statuses`} />
        <Stat label="At your places this week" value={fmtHours(weekMs)} href="/places/log" note="Since Monday" />
      </div>

      <div class="govuk-grid-row">
        <div class="govuk-grid-column-two-thirds">
          <h2 class="govuk-heading-m">Coming up</h2>
          {dueSoon.length === 0 ? (
            <p class="govuk-body">Nothing due.</p>
          ) : (
            <ul class="govuk-task-list">
              {dueSoon.map((t) => (
                <li class="govuk-task-list__item govuk-task-list__item--with-link">
                  <div class="govuk-task-list__name-and-hint">
                    <a class="govuk-link govuk-task-list__link" href={`/tasks/${t.id}`} data-modal>
                      {t.title}
                    </a>
                    <div class="govuk-task-list__hint">
                      {t.due_by! < today ? `Was due ${fmtDate(t.due_by)}` : `Due ${fmtDate(t.due_by)}`}
                      {t.domains.length > 0 && ` · ${t.domains.map((d) => d.name).join(", ")}`}
                    </div>
                  </div>
                  <div class="govuk-task-list__status">
                    {t.due_by! < today ? <Tag colour="red">Overdue</Tag> : <Tag colour={t.status_colour}>{t.status_name}</Tag>}
                  </div>
                </li>
              ))}
            </ul>
          )}

          <h2 class="govuk-heading-m">Journal today</h2>
          {entries.length === 0 ? (
            <p class="govuk-body">Nothing written yet today.</p>
          ) : (
            <ul class="govuk-list govuk-list--bullet">
              {entries.map((e) => (
                <li>
                  <a class="govuk-link" href={`/journal/entry/${e.id}`}>
                    {e.title}
                  </a>
                </li>
              ))}
            </ul>
          )}
          <p class="govuk-body">
            <a class="govuk-link" href={`/journal/day/${today}`}>
              See everything from today
            </a>
          </p>
        </div>

        <div class="govuk-grid-column-one-third">
          <h2 class="govuk-heading-m">Open tasks by status</h2>
          <ul class="govuk-list lg-counts">
            {statuses.map((s) => (
              <li class="lg-counts__row">
                <a class="lg-counts__link" href={`/tasks?status=${s.id}`}>
                  <Tag colour={s.colour}>{s.name}</Tag>
                </a>
                <span class="lg-counts__n">{open.filter((t) => t.status_id === s.id).length}</span>
              </li>
            ))}
          </ul>
          <ButtonLink href="/tasks/board" variant="secondary">
            Open the task board
          </ButtonLink>
        </div>
      </div>
    </>,
  );
});
