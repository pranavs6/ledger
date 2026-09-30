import { Hono } from "hono";
import { localDate, shiftDay } from "../db.ts";
import { daySummaries } from "../goals.ts";
import { ButtonLink, fmtDay } from "../views/components.tsx";
import { type Env, page } from "../web.tsx";

export const calendarRoutes = new Hono<Env>();

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const monthName = (y: number, m: number) =>
  new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });

const monthKey = (y: number, m: number) => {
  const d = new Date(y, m - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

calendarRoutes.get("/", (c) => {
  const user = c.get("user");
  const today = localDate();
  const q = c.req.query("month");
  const [y, m] = (q && /^\d{4}-(0[1-9]|1[0-2])$/.test(q) ? q : today.slice(0, 7)).split("-").map(Number);

  // Whole weeks, Monday first, covering the month.
  const first = new Date(y, m - 1, 1);
  const start = localDate(new Date(y, m - 1, 1 - ((first.getDay() + 6) % 7)));
  const last = localDate(new Date(y, m, 0));
  const days: string[] = [];
  for (let d = start; d <= last || days.length % 7; d = shiftDay(d, 1)) days.push(d);
  const weeks = Array.from({ length: days.length / 7 }, (_, i) => days.slice(i * 7, i * 7 + 7));
  const summary = daySummaries(user.id, days[0], days[days.length - 1]);
  const inMonth = (d: string) => d.slice(0, 7) === monthKey(y, m);

  const prev = monthKey(y, m - 1);
  const next = monthKey(y, m + 1);

  return page(
    c,
    { title: `Calendar: ${monthName(y, m)}`, nav: "calendar", wide: true },
    <>
      <div class="lg-title-row">
        <div>
          <span class="govuk-caption-l">Calendar</span>
          <h1 class="govuk-heading-l">{monthName(y, m)}</h1>
        </div>
        <div class="govuk-button-group">
          <ButtonLink href={`/journal/day/${today}`}>Plan today</ButtonLink>
          {monthKey(y, m) !== today.slice(0, 7) && (
            <ButtonLink href="/calendar" variant="secondary">
              This month
            </ButtonLink>
          )}
        </div>
      </div>
      <p class="govuk-body lg-muted">Select a day to set its goals, write in the journal and see what happened.</p>

      <table class="lg-cal">
        <caption class="govuk-visually-hidden">{monthName(y, m)}</caption>
        <thead>
          <tr>
            {WEEKDAYS.map((w) => (
              <th scope="col" class="lg-cal__weekday">
                <span aria-hidden="true">{w.slice(0, 3)}</span>
                <span class="govuk-visually-hidden">{w}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr>
              {week.map((d) => {
                const s = summary.get(d);
                const cls = [
                  "lg-cal__day",
                  !inMonth(d) && "lg-cal__day--other",
                  d === today && "lg-cal__day--today",
                  d < today && "lg-cal__day--past",
                ]
                  .filter(Boolean)
                  .join(" ");
                const allDone = s && s.goals > 0 && s.done === s.goals;
                return (
                  <td class={cls}>
                    <a class="lg-cal__link" href={`/journal/day/${d}`} aria-current={d === today ? "date" : undefined}>
                      <span class="lg-cal__num">
                        <span aria-hidden="true">{Number(d.slice(8))}</span>
                        <span class="govuk-visually-hidden">{fmtDay(d)}</span>
                        {d === today && <span class="lg-cal__today">Today</span>}
                      </span>
                      {s && s.goals > 0 && (
                        <span class={`lg-cal__goals${allDone ? " lg-cal__goals--done" : ""}`}>
                          <span class="lg-cal__meter" aria-hidden="true">
                            <span style={`width:${Math.round((s.done / s.goals) * 100)}%`}></span>
                          </span>
                          {s.done}/{s.goals}
                          <span class="lg-cal__label"> goals</span>
                          <span class="govuk-visually-hidden"> done</span>
                        </span>
                      )}
                      {s && s.entries > 0 && (
                        <span class="lg-cal__note lg-cal__label">{plural(s.entries, "journal entry", "journal entries")}</span>
                      )}
                      {s && s.due > 0 && <span class="lg-cal__note lg-cal__due">{s.due} due</span>}
                    </a>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <nav class="govuk-pagination govuk-pagination--block" aria-label="Months">
        <div class="govuk-pagination__prev">
          <a class="govuk-link govuk-pagination__link" href={`/calendar?month=${prev}`} rel="prev">
            <span class="govuk-pagination__link-title">Previous month</span>
            <span class="govuk-visually-hidden">:</span>
            <span class="govuk-pagination__link-label">{monthName(y, m - 1)}</span>
          </a>
        </div>
        <div class="govuk-pagination__next">
          <a class="govuk-link govuk-pagination__link" href={`/calendar?month=${next}`} rel="next">
            <span class="govuk-pagination__link-title">Next month</span>
            <span class="govuk-visually-hidden">:</span>
            <span class="govuk-pagination__link-label">{monthName(y, m + 1)}</span>
          </a>
        </div>
      </nav>
    </>,
  );
});
