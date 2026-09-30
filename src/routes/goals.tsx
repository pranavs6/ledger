import { Hono } from "hono";
import type { FC } from "hono/jsx";
import { audit } from "../auth.ts";
import { isDate, localDate } from "../db.ts";
import { addGoal, carryOver, deleteGoal, type Goal, getGoal, setGoalDone, unfinishedBefore, updateGoal } from "../goals.ts";
import { getTask, listTasks, type Task } from "../tasks.ts";
import {
  BackLink,
  Button,
  ButtonGroup,
  ErrorSummary,
  type Errors,
  fmtDay,
  fmtShortDate,
  Input,
  Select,
  Tag,
} from "../views/components.tsx";
import { type Ctx, type Env, type Form, flash, form, intParam, page, safeNext } from "../web.tsx";

export const goalRoutes = new Hono<Env>();

const dayHref = (date: string) => `/journal/day/${date}`;

const taskOptions = (tasks: Task[]) => [
  { value: "", text: "No task" },
  ...tasks.map((t) => ({ value: String(t.id), text: t.title })),
];

// ---------------------------------------------------------------- components

export const GoalCount: FC<{ goals: Goal[] }> = ({ goals }) => (
  <p class="govuk-body-s lg-muted" data-goal-count>
    {goals.filter((g) => g.done_at).length} of {goals.length} done
  </p>
);

/** A day's goals as a checklist. Each tick is its own form, so it works without JS. */
export const GoalList: FC<{ goals: Goal[]; back: string }> = ({ goals, back }) => (
  <ul class="lg-goals" data-goals>
    {goals.map((g) => {
      const done = !!g.done_at;
      const taskIsTitle = g.task_id && g.task_title === g.title;
      return (
        <li class={`lg-goal${done ? " lg-goal--done" : ""}`}>
          <form method="post" action={`/goals/${g.id}/done`} class="lg-goal__toggle" data-goal-toggle>
            <input type="hidden" name="back" value={back} />
            <input type="hidden" name="done" value={done ? "0" : "1"} />
            <button type="submit" class="lg-goal__check" data-title={g.title}>
              <span class="govuk-visually-hidden">
                Mark ‘{g.title}’ as {done ? "not done" : "done"}
              </span>
            </button>
          </form>
          <div class="lg-goal__body">
            <span class="lg-goal__title">
              {taskIsTitle ? (
                <a class="govuk-link" href={`/tasks/${g.task_id}`} data-modal>
                  {g.title}
                </a>
              ) : (
                g.title
              )}
            </span>
            {(g.task_id || g.carried_from) && (
              <span class="lg-goal__meta">
                {g.task_id && !taskIsTitle && (
                  <a class="govuk-link" href={`/tasks/${g.task_id}`} data-modal>
                    {g.task_title}
                  </a>
                )}
                {g.task_id && <Tag colour={g.status_colour ?? "grey"}>{g.status_name}</Tag>}
                {g.carried_from && <span class="lg-muted">Carried over from {fmtShortDate(g.carried_from)}</span>}
              </span>
            )}
          </div>
          <a class="govuk-link lg-goal__change" href={`/goals/${g.id}/edit?back=${encodeURIComponent(back)}`} data-modal>
            Change<span class="govuk-visually-hidden"> {g.title}</span>
          </a>
        </li>
      );
    })}
  </ul>
);

export const AddGoal: FC<{ date: string; back: string; tasks: Task[] }> = ({ date, back, tasks }) => (
  <form method="post" action="/goals" class="lg-filters lg-goal-add">
    <input type="hidden" name="goal_date" value={date} />
    <input type="hidden" name="back" value={back} />
    <Input name="title" label="Add a goal" />
    {tasks.length > 0 && <Select name="task_id" label="For a task (optional)" options={taskOptions(tasks)} />}
    <Button variant="secondary">Add goal</Button>
  </form>
);

/** Goals left unfinished on the days before `date`, with a way to bring them forward. */
export const CarryOver: FC<{ goals: Goal[]; date: string; back: string }> = ({ goals, date, back }) => {
  if (!goals.length) return null;
  return (
    <div class="lg-carry">
      <h3 class="govuk-heading-s">Not finished on earlier days</h3>
      <ul class="govuk-list lg-carry__list">
        {goals.map((g) => (
          <li>
            <form method="post" action="/goals/carry" class="lg-inline-form">
              <input type="hidden" name="to" value={date} />
              <input type="hidden" name="ids" value={String(g.id)} />
              <input type="hidden" name="back" value={back} />
              {g.title} <span class="lg-muted">· {fmtShortDate(g.goal_date)}</span>{" "}
              <button type="submit" class="lg-link-button govuk-link govuk-body-s">
                Move to {date === localDate() ? "today" : fmtShortDate(date)}
                <span class="govuk-visually-hidden">: {g.title}</span>
              </button>
            </form>
          </li>
        ))}
      </ul>
      {goals.length > 1 && (
        <form method="post" action="/goals/carry">
          <input type="hidden" name="to" value={date} />
          <input type="hidden" name="ids" value={goals.map((g) => g.id).join(",")} />
          <input type="hidden" name="back" value={back} />
          <Button variant="secondary" small>
            Move all {goals.length} to {date === localDate() ? "today" : fmtShortDate(date)}
          </Button>
        </form>
      )}
    </div>
  );
};

/** Everything the day page and Today need to show a day's goals. */
export function goalsSection(userId: number, date: string) {
  return {
    tasks: listTasks(userId, { status: "open", sort: "title" }),
    unfinished: date <= localDate() ? unfinishedBefore(userId, date) : [],
  };
}

// ---------------------------------------------------------------- add / change

function validate(userId: number, f: Form): { errors: Errors; taskId: number | null } {
  const errors: Errors = {};
  const task = f.task_id ? getTask(userId, Number(f.task_id)) : undefined;
  if (f.task_id && !task) errors.task_id = "Select a task from the list";
  if (!f.title && task) f.title = task.title;
  if (!f.title) errors.title = "Enter a goal, or select a task";
  else if (f.title.length > 200) errors.title = "Goal must be 200 characters or fewer";
  if (!f.goal_date) errors.goal_date = "Enter a date";
  else if (!isDate(f.goal_date)) errors.goal_date = "Date must be a real date";
  return { errors, taskId: task?.id ?? null };
}

function goalForm(c: Ctx, opts: { goal?: Goal; values: Form; errors?: Errors }) {
  const errors = opts.errors ?? {};
  const v = opts.values;
  const back = safeNext(v.back, dayHref(isDate(v.goal_date) ? v.goal_date : localDate()));
  const title = opts.goal ? "Change goal" : "Add a goal";
  return page(
    c,
    { title, nav: "calendar", error: Object.keys(errors).length > 0 },
    <div class="govuk-grid-row">
      <div class="govuk-grid-column-two-thirds">
        <BackLink href={back} />
        <ErrorSummary errors={errors} />
        <span class="govuk-caption-l">Goals</span>
        <h1 class="govuk-heading-l">{title}</h1>
        <form method="post" action={opts.goal ? `/goals/${opts.goal.id}` : "/goals"} novalidate>
          <input type="hidden" name="back" value={back} />
          <Input name="title" label="Goal" value={v.title} error={errors.title} />
          <Input name="goal_date" label="Day" type="date" value={v.goal_date} error={errors.goal_date} width="10" />
          <Select
            name="task_id"
            label="For a task (optional)"
            hint="Leave the goal blank to use the task's title."
            options={taskOptions(listTasks(c.get("user").id, { status: "open", sort: "title" }))}
            value={v.task_id}
            error={errors.task_id}
          />
          <ButtonGroup>
            <Button>{opts.goal ? "Save goal" : "Add goal"}</Button>
            <a class="govuk-link" href={back} data-close>
              Cancel
            </a>
          </ButtonGroup>
        </form>
        {opts.goal && (
          <form method="post" action={`/goals/${opts.goal.id}/delete`}>
            <input type="hidden" name="back" value={back} />
            <Button variant="warning">Delete goal</Button>
          </form>
        )}
      </div>
    </div>,
  );
}

goalRoutes.get("/new", (c) => {
  const d = c.req.query("date");
  return goalForm(c, { values: { goal_date: isDate(d) ? d : localDate(), task_id: c.req.query("task_id") ?? "", back: c.req.query("back") ?? "" } });
});

goalRoutes.post("/", async (c) => {
  const user = c.get("user");
  const f = await form(c);
  const { errors, taskId } = validate(user.id, f);
  if (Object.keys(errors).length) {
    c.status(400);
    return goalForm(c, { values: f, errors });
  }
  addGoal(user.id, { goal_date: f.goal_date, title: f.title, task_id: taskId });
  audit(user.id, "goal added", `${f.goal_date}: ${f.title}`, c.get("ip"));
  flash(c, "Goal added");
  return c.redirect(safeNext(f.back, dayHref(f.goal_date)));
});

goalRoutes.post("/carry", async (c) => {
  const user = c.get("user");
  const f = await form(c);
  const to = isDate(f.to) ? f.to : localDate();
  const ids = (f.ids ?? "").split(",").map(Number).filter(Number.isInteger);
  const n = carryOver(user.id, ids, to);
  if (n) {
    audit(user.id, "goals carried over", `${n} to ${to}`, c.get("ip"));
    flash(c, n === 1 ? `Goal moved to ${fmtDay(to)}` : `${n} goals moved to ${fmtDay(to)}`);
  }
  return c.redirect(safeNext(f.back, dayHref(to)));
});

goalRoutes.get("/:id/edit", (c) => {
  const g = getGoal(c.get("user").id, intParam(c));
  if (!g) return c.notFound();
  return goalForm(c, {
    goal: g,
    values: { title: g.title, goal_date: g.goal_date, task_id: g.task_id ? String(g.task_id) : "", back: c.req.query("back") ?? "" },
  });
});

goalRoutes.post("/:id", async (c) => {
  const user = c.get("user");
  const g = getGoal(user.id, intParam(c));
  if (!g) return c.notFound();
  const f = await form(c);
  const { errors, taskId } = validate(user.id, f);
  if (Object.keys(errors).length) {
    c.status(400);
    return goalForm(c, { goal: g, values: f, errors });
  }
  updateGoal(user.id, g.id, { goal_date: f.goal_date, title: f.title, task_id: taskId });
  flash(c, f.goal_date === g.goal_date ? "Goal saved" : `Goal moved to ${fmtDay(f.goal_date)}`);
  return c.redirect(safeNext(f.back, dayHref(g.goal_date)));
});

goalRoutes.post("/:id/done", async (c) => {
  const user = c.get("user");
  const f = await form(c);
  const done = f.done === "1";
  const ok = setGoalDone(user.id, intParam(c), done);
  // client/boot.ts ticks goals over fetch and asks for JSON.
  if (c.req.header("accept")?.includes("application/json")) return c.json({ ok, done }, ok ? 200 : 404);
  if (!ok) return c.notFound();
  return c.redirect(safeNext(f.back, "/"));
});

goalRoutes.post("/:id/delete", async (c) => {
  const user = c.get("user");
  const g = getGoal(user.id, intParam(c));
  if (!g) return c.notFound();
  const f = await form(c);
  deleteGoal(user.id, g.id);
  audit(user.id, "goal deleted", `${g.goal_date}: ${g.title}`, c.get("ip"));
  flash(c, "Goal deleted");
  return c.redirect(safeNext(f.back, dayHref(g.goal_date)));
});
