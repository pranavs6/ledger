import { Hono } from "hono";
import { audit } from "../auth.ts";
import { dayBounds, db, isDate, likeArg, localDate, now, shiftDay } from "../db.ts";
import { goalsOn } from "../goals.ts";
import { visitMs, visits } from "../places.ts";
import { eventsBetween } from "../tasks.ts";
import { AddGoal, CarryOver, GoalCount, GoalList, goalsSection } from "./goals.tsx";
import {
  BackLink,
  Button,
  ButtonGroup,
  ButtonLink,
  ErrorSummary,
  type Errors,
  fmtDate,
  fmtDay,
  fmtDuration,
  fmtTime,
  Input,
  Markdown,
  SummaryCard,
  Tag,
  Textarea,
} from "../views/components.tsx";
import { type Ctx, type Env, type Form, flash, form, intParam, page } from "../web.tsx";

export const journalRoutes = new Hono<Env>();

interface Entry {
  id: number;
  title: string;
  body: string;
  entry_date: string;
  created_at: string;
  updated_at: string;
}

const getEntry = (userId: number, id: number) =>
  db()
    .prepare("SELECT id, title, body, entry_date, created_at, updated_at FROM journal_entries WHERE user_id = ? AND id = ? AND deleted_at IS NULL")
    .get(userId, id) as Entry | undefined;

const entriesOn = (userId: number, date: string) =>
  db()
    .prepare(
      "SELECT id, title, body, entry_date, created_at, updated_at FROM journal_entries WHERE user_id = ? AND entry_date = ? AND deleted_at IS NULL ORDER BY created_at",
    )
    .all(userId, date) as Entry[];

const excerpt = (s: string, n = 180) => {
  const plain = s
    .split("\n")
    .map((line) => line.replace(/^\s*([-*+>#]+|\d+\.)\s*/, "").replace(/[*_`]/g, "").trim())
    .filter(Boolean)
    .join(" · ");
  return plain.length > n ? `${plain.slice(0, n)}…` : plain;
};

// ---------------------------------------------------------------- list

journalRoutes.get("/", (c) => {
  const user = c.get("user");
  const q = c.req.query("q")?.trim() ?? "";
  const rows = (
    q
      ? db()
          .prepare(
            `SELECT id, title, body, entry_date, created_at, updated_at FROM journal_entries
             WHERE user_id = ? AND deleted_at IS NULL AND (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')
             ORDER BY entry_date DESC, created_at DESC LIMIT 200`,
          )
          .all(user.id, likeArg(q), likeArg(q))
      : db()
          .prepare(
            `SELECT id, title, body, entry_date, created_at, updated_at FROM journal_entries
             WHERE user_id = ? AND deleted_at IS NULL ORDER BY entry_date DESC, created_at DESC LIMIT 100`,
          )
          .all(user.id)
  ) as Entry[];

  const byDate = new Map<string, Entry[]>();
  for (const e of rows) byDate.set(e.entry_date, [...(byDate.get(e.entry_date) ?? []), e]);

  return page(
    c,
    { title: "Journal", nav: "journal" },
    <>
      <div class="lg-title-row">
        <h1 class="govuk-heading-l">Journal</h1>
        <ButtonGroup>
          <ButtonLink href="/journal/new">Write in journal</ButtonLink>
          <ButtonLink href={`/journal/day/${localDate()}`} variant="secondary">
            Today
          </ButtonLink>
        </ButtonGroup>
      </div>
      <div class="govuk-grid-row">
        <div class="govuk-grid-column-two-thirds">
          <form method="get" action="/journal" class="lg-filters" role="search">
            <Input name="q" label="Search the journal" value={q} />
            <Button variant="secondary">Search</Button>
          </form>
        </div>
        <div class="govuk-grid-column-one-third">
          <form method="get" action="/journal/day" class="lg-filters">
            <Input name="date" label="Go to a day" type="date" value={localDate()} width="10" />
            <Button variant="secondary">Go</Button>
          </form>
        </div>
      </div>

      {rows.length === 0 && (
        <p class="govuk-body">{q ? `No entries match ‘${q}’.` : "Nothing written yet. Entries you write show here, newest first."}</p>
      )}
      {[...byDate].map(([date, entries]) => (
        <section class="lg-day">
          <h2 class="govuk-heading-m">
            <a class="govuk-link govuk-link--no-visited-state" href={`/journal/day/${date}`}>
              {fmtDay(date)}
            </a>
          </h2>
          <ul class="govuk-list lg-entry-list">
            {entries.map((e) => (
              <li>
                <a class="govuk-link govuk-!-font-weight-bold" href={`/journal/entry/${e.id}`}>
                  {e.title}
                </a>
                {e.body && <p class="govuk-body-s lg-muted">{excerpt(e.body)}</p>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>,
  );
});

journalRoutes.get("/day", (c) => {
  const d = c.req.query("date");
  return c.redirect(`/journal/day/${isDate(d) ? d : localDate()}`);
});

// ---------------------------------------------------------------- day view

journalRoutes.get("/day/:date", (c) => {
  const user = c.get("user");
  const date = c.req.param("date");
  if (!isDate(date)) return c.notFound();
  const [from, to] = dayBounds(date);
  const entries = entriesOn(user.id, date);
  const moves = eventsBetween(user.id, from, to);
  const stays = visits(user.id, { from, to }).reverse();
  const today = localDate();
  const goals = goalsOn(user.id, date);
  const { tasks, unfinished } = goalsSection(user.id, date);
  const back = `/journal/day/${date}`;
  const caption =
    date === today ? "Today" : date === shiftDay(today, 1) ? "Tomorrow" : date === shiftDay(today, -1) ? "Yesterday" : "Day";

  return page(
    c,
    { title: fmtDay(date), nav: "calendar" },
    <>
      <BackLink href={`/calendar?month=${date.slice(0, 7)}`} text="Calendar" />
      <span class="govuk-caption-l">{caption}</span>
      <h1 class="govuk-heading-l">{fmtDay(date)}</h1>

      <div class="govuk-grid-row">
        <div class="govuk-grid-column-two-thirds">
          <section class="lg-day-goals" aria-labelledby="goals-heading">
            <h2 class="govuk-heading-m" id="goals-heading">
              Goals
            </h2>
            {goals.length === 0 ? (
              <p class="govuk-body">{date < today ? "No goals were set for this day." : "No goals yet. What do you want to get done?"}</p>
            ) : (
              <>
                <GoalCount goals={goals} />
                <GoalList goals={goals} back={back} />
              </>
            )}
            <AddGoal date={date} back={back} tasks={tasks} />
            {date === today && <CarryOver goals={unfinished} date={date} back={back} />}
          </section>

          <h2 class="govuk-heading-m">Journal</h2>
          <ButtonLink href={`/journal/new?date=${date}`} variant="secondary">
            Write in journal
          </ButtonLink>
          {entries.length === 0 && <p class="govuk-body">No journal entries for this day.</p>}
          {entries.map((e) => (
            <SummaryCard
              title={e.title}
              actions={[
                <a class="govuk-link" href={`/journal/entry/${e.id}/edit`}>
                  Change<span class="govuk-visually-hidden"> {e.title}</span>
                </a>,
                <a class="govuk-link" href={`/journal/entry/${e.id}/delete`}>
                  Delete<span class="govuk-visually-hidden"> {e.title}</span>
                </a>,
              ]}
            >
              <Markdown src={e.body} />
            </SummaryCard>
          ))}
        </div>

        <div class="govuk-grid-column-one-third">
          <h2 class="govuk-heading-m">Where you were</h2>
          {stays.length === 0 ? (
            <p class="govuk-body-s lg-muted">No visits logged.</p>
          ) : (
            <ul class="govuk-list lg-stays">
              {stays.map((v) => (
                <li>
                  <strong>{v.place_name}</strong>
                  <br />
                  <span class="govuk-body-s">
                    {v.entered_at < from ? "Before midnight" : fmtTime(v.entered_at)} to{" "}
                    {v.exited_at ? (v.exited_at >= to ? "after midnight" : fmtTime(v.exited_at)) : "now"}
                    {" · "}
                    {fmtDuration(visitMs(v, from, to))}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <h2 class="govuk-heading-m">Task changes</h2>
          {moves.length === 0 ? (
            <p class="govuk-body-s lg-muted">No task changes.</p>
          ) : (
            <ol class="lg-timeline">
              {moves.map((m) => (
                <li class="lg-timeline__item">
                  <p class="govuk-body-s lg-muted lg-timeline__when">{fmtTime(m.at)}</p>
                  <p class="govuk-body-s">
                    <a class="govuk-link" href={`/tasks/${m.task_id}`} data-modal>
                      {m.title}
                    </a>
                    <br />
                    {m.from_name ? "Moved to " : "Added in "}
                    <Tag colour={m.to_colour}>{m.to_name}</Tag>
                  </p>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>

      <nav class="govuk-pagination govuk-pagination--block" aria-label="Days">
        <div class="govuk-pagination__prev">
          <a class="govuk-link govuk-pagination__link" href={`/journal/day/${shiftDay(date, -1)}`} rel="prev">
            <span class="govuk-pagination__link-title">Previous day</span>
            <span class="govuk-visually-hidden">:</span>
            <span class="govuk-pagination__link-label">{fmtDay(shiftDay(date, -1))}</span>
          </a>
        </div>
        <div class="govuk-pagination__next">
          <a class="govuk-link govuk-pagination__link" href={`/journal/day/${shiftDay(date, 1)}`} rel="next">
            <span class="govuk-pagination__link-title">Next day</span>
            <span class="govuk-visually-hidden">:</span>
            <span class="govuk-pagination__link-label">{fmtDay(shiftDay(date, 1))}</span>
          </a>
        </div>
      </nav>
    </>,
  );
});

// ---------------------------------------------------------------- create / edit

function validate(f: Form): Errors {
  const errors: Errors = {};
  if (!f.title) errors.title = "Enter a title";
  else if (f.title.length > 200) errors.title = "Title must be 200 characters or fewer";
  if (!f.entry_date) errors.entry_date = "Enter a date";
  else if (!isDate(f.entry_date)) errors.entry_date = "Date must be a real date";
  return errors;
}

function entryForm(c: Ctx, opts: { entry?: Entry; values: Form; errors?: Errors }) {
  const errors = opts.errors ?? {};
  const v = opts.values;
  const back = opts.entry ? `/journal/entry/${opts.entry.id}` : "/journal";
  return page(
    c,
    { title: opts.entry ? "Change journal entry" : "Write in journal", nav: "journal", error: Object.keys(errors).length > 0 },
    <div class="govuk-grid-row">
      <div class="govuk-grid-column-two-thirds">
        <BackLink href={back} />
        <ErrorSummary errors={errors} />
        <span class="govuk-caption-l">Journal</span>
        <h1 class="govuk-heading-l">{opts.entry ? "Change journal entry" : "Write in journal"}</h1>
        <form method="post" action={opts.entry ? `/journal/entry/${opts.entry.id}` : "/journal"} novalidate>
          <Input name="title" label="Title" value={v.title} error={errors.title} />
          <Input name="entry_date" label="Date" type="date" value={v.entry_date} error={errors.entry_date} width="10" />
          <Textarea name="body" label="Body" hint="You can use Markdown: lists, links, **bold**, `code`." value={v.body} rows={14} />
          <ButtonGroup>
            <Button>{opts.entry ? "Save changes" : "Save entry"}</Button>
            <a class="govuk-link" href={back}>
              Cancel
            </a>
          </ButtonGroup>
        </form>
      </div>
    </div>,
  );
}

journalRoutes.get("/new", (c) => {
  const d = c.req.query("date");
  return entryForm(c, { values: { entry_date: isDate(d) ? d : localDate() } });
});

journalRoutes.post("/", async (c) => {
  const user = c.get("user");
  const f = await form(c);
  const errors = validate(f);
  if (Object.keys(errors).length) {
    c.status(400);
    return entryForm(c, { values: f, errors });
  }
  const at = now();
  const { lastInsertRowid } = db()
    .prepare("INSERT INTO journal_entries (user_id, title, body, entry_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(user.id, f.title, f.body ?? "", f.entry_date, at, at);
  audit(user.id, "journal entry added", f.title, c.get("ip"));
  flash(c, "Entry saved");
  return c.redirect(`/journal/entry/${lastInsertRowid}`);
});

journalRoutes.get("/entry/:id", (c) => {
  const e = getEntry(c.get("user").id, intParam(c));
  if (!e) return c.notFound();
  return page(
    c,
    { title: e.title, nav: "journal" },
    <div class="govuk-grid-row">
      <div class="govuk-grid-column-two-thirds">
        <BackLink href={`/journal/day/${e.entry_date}`} text={fmtDay(e.entry_date)} />
        <span class="govuk-caption-l">{fmtDate(e.entry_date)}</span>
        <h1 class="govuk-heading-l">{e.title}</h1>
        <Markdown src={e.body} />
        <p class="govuk-body-s lg-muted">
          Written {fmtDate(e.created_at)} at {fmtTime(e.created_at)}
          {e.updated_at !== e.created_at && <> · last changed {fmtDate(e.updated_at)} at {fmtTime(e.updated_at)}</>}
        </p>
        <ButtonGroup>
          <ButtonLink href={`/journal/entry/${e.id}/edit`} variant="secondary">
            Change entry
          </ButtonLink>
          <a class="govuk-link" href={`/journal/entry/${e.id}/delete`}>
            Delete entry
          </a>
        </ButtonGroup>
      </div>
    </div>,
  );
});

journalRoutes.get("/entry/:id/edit", (c) => {
  const e = getEntry(c.get("user").id, intParam(c));
  if (!e) return c.notFound();
  return entryForm(c, { entry: e, values: { title: e.title, body: e.body, entry_date: e.entry_date } });
});

journalRoutes.post("/entry/:id", async (c) => {
  const user = c.get("user");
  const e = getEntry(user.id, intParam(c));
  if (!e) return c.notFound();
  const f = await form(c);
  const errors = validate(f);
  if (Object.keys(errors).length) {
    c.status(400);
    return entryForm(c, { entry: e, values: f, errors });
  }
  db()
    .prepare("UPDATE journal_entries SET title = ?, body = ?, entry_date = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(f.title, f.body ?? "", f.entry_date, now(), e.id, user.id);
  audit(user.id, "journal entry changed", f.title, c.get("ip"));
  flash(c, "Entry saved");
  return c.redirect(`/journal/entry/${e.id}`);
});

journalRoutes.get("/entry/:id/delete", (c) => {
  const e = getEntry(c.get("user").id, intParam(c));
  if (!e) return c.notFound();
  return page(
    c,
    { title: `Delete ${e.title}`, nav: "journal" },
    <div class="govuk-grid-row">
      <div class="govuk-grid-column-two-thirds">
        <BackLink href={`/journal/entry/${e.id}`} />
        <h1 class="govuk-heading-l">Are you sure you want to delete ‘{e.title}’?</h1>
        <form method="post" action={`/journal/entry/${e.id}/delete`}>
          <ButtonGroup>
            <Button variant="warning">Yes, delete entry</Button>
            <a class="govuk-link" href={`/journal/entry/${e.id}`}>
              No, keep it
            </a>
          </ButtonGroup>
        </form>
      </div>
    </div>,
  );
});

journalRoutes.post("/entry/:id/delete", (c) => {
  const user = c.get("user");
  const e = getEntry(user.id, intParam(c));
  if (!e) return c.notFound();
  db().prepare("UPDATE journal_entries SET deleted_at = ? WHERE id = ? AND user_id = ?").run(now(), e.id, user.id);
  audit(user.id, "journal entry deleted", e.title, c.get("ip"));
  flash(c, "Entry deleted");
  return c.redirect(`/journal/day/${e.entry_date}`);
});
