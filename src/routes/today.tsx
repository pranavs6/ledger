import { Hono } from "hono";
import { listCategories } from "../categories.ts";
import { db, localDate } from "../db.ts";
import { listPlaces } from "../places.ts";
import { listTasks } from "../tasks.ts";
import { ButtonGroup, ButtonLink, fmtDate, fmtDay, fmtTime, Tag } from "../views/components.tsx";
import { type Env, page } from "../web.tsx";

export const todayRoutes = new Hono<Env>();

todayRoutes.get("/", (c) => {
  const user = c.get("user");
  const today = localDate();
  const here = listPlaces(user.id).filter((p) => p.here_since);
  const open = listTasks(user.id, { status: "open" });
  const dueSoon = listTasks(user.id, { status: "open", due: "week" });
  const statuses = listCategories("statuses", user.id).filter((s) => !s.is_closed);
  const entries = db()
    .prepare("SELECT id, title FROM journal_entries WHERE user_id = ? AND entry_date = ? AND deleted_at IS NULL ORDER BY created_at")
    .all(user.id, today) as { id: number; title: string }[];

  return page(
    c,
    { title: "Today", nav: "today" },
    <>
      <span class="govuk-caption-l">{fmtDay(today)}</span>
      <h1 class="govuk-heading-l">Today</h1>
      <p class="govuk-body-l">
        {here.length ? (
          <>
            You are at <strong>{here.map((p) => p.name).join(" and ")}</strong>, since {fmtTime(here[0].here_since!)}.
          </>
        ) : (
          "You are not at any of your places."
        )}
      </p>

      <div class="govuk-grid-row">
        <div class="govuk-grid-column-two-thirds">
          <h2 class="govuk-heading-m">Due in the next 7 days</h2>
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
                      {t.due_by! < today ? `Overdue, was due ${fmtDate(t.due_by)}` : `Due ${fmtDate(t.due_by)}`}
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

          <h2 class="govuk-heading-m">Journal</h2>
          {entries.length === 0 ? (
            <p class="govuk-body">Nothing written today.</p>
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
          <ButtonGroup>
            <ButtonLink href="/journal/new">Write in journal</ButtonLink>
            <ButtonLink href={`/journal/day/${today}`} variant="secondary">
              See today in full
            </ButtonLink>
          </ButtonGroup>
        </div>

        <div class="govuk-grid-column-one-third">
          <h2 class="govuk-heading-m">Open tasks</h2>
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
          <ButtonLink href="/tasks/new" variant="secondary" modal>
            Add a task
          </ButtonLink>
        </div>
      </div>
    </>,
  );
});
