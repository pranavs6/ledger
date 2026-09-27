import { Hono } from "hono";
import type { FC } from "hono/jsx";
import { audit } from "../auth.ts";
import { type Category, ensureDomains, listCategories, readDomainFields } from "../categories.ts";
import { isDate, localDate } from "../db.ts";
import {
  createTask,
  deleteTask,
  getTask,
  listTasks,
  setStatus,
  type Task,
  type TaskFilter,
  type TaskInput,
  taskHistory,
  updateTask,
} from "../tasks.ts";
import {
  BackLink,
  Button,
  ButtonGroup,
  ButtonLink,
  DomainPicker,
  DomainTags,
  ErrorSummary,
  type Errors,
  fmtDate,
  fmtDateTime,
  Input,
  Markdown,
  type Option,
  Select,
  SummaryList,
  Tag,
  Textarea,
  WarningText,
} from "../views/components.tsx";
import { type Ctx, type Env, type Form, flash, form, intParam, page, safeNext } from "../web.tsx";

export const taskRoutes = new Hono<Env>();

/** Closed columns only show recent tasks, so Done does not grow forever. */
const CLOSED_COLUMN_DAYS = 14;

const isOverdue = (t: Task) => !t.is_closed && !!t.due_by && t.due_by < localDate();

export const StatusTag: FC<{ t: Task }> = ({ t }) => <Tag colour={t.status_colour}>{t.status_name}</Tag>;
export const DomainTag: FC<{ t: Task }> = ({ t }) => <DomainTags domains={t.domains} />;

const Due: FC<{ t: Task }> = ({ t }) =>
  t.due_by ? (
    <>
      {fmtDate(t.due_by)} {isOverdue(t) && <Tag colour="red">Overdue</Tag>}
    </>
  ) : null;

const toOptions = (list: Category[]): Option[] => list.map((x) => ({ value: String(x.id), text: x.name }));

// ---------------------------------------------------------------- list

taskRoutes.get("/", (c) => {
  const user = c.get("user");
  const q = c.req.query();
  const filter: TaskFilter = {
    status: q.status || "open",
    domain: q.domain ?? "",
    due: (q.due ?? "") as TaskFilter["due"],
    q: q.q?.trim() ?? "",
    sort: (["due", "created", "updated", "title", "status"].includes(q.sort) ? q.sort : "due") as TaskFilter["sort"],
  };
  const tasks = listTasks(user.id, filter);
  const statuses = listCategories("statuses", user.id);
  const domains = listCategories("domains", user.id);
  return page(
    c,
    { title: "Tasks", nav: "tasks", wide: true },
    <>
      <div class="lg-title-row">
        <h1 class="govuk-heading-l">Tasks</h1>
        <ButtonGroup>
          <ButtonLink href="/tasks/new" modal>
            Add a task
          </ButtonLink>
          <ButtonLink href="/tasks/board" variant="secondary">
            View as board
          </ButtonLink>
        </ButtonGroup>
      </div>

      <form method="get" action="/tasks" class="lg-filters" role="search">
        <Input name="q" label="Search" value={filter.q} />
        <Select
          name="status"
          label="Status"
          value={filter.status}
          options={[
            { value: "open", text: "Open" },
            { value: "closed", text: "Closed" },
            { value: "all", text: "All" },
            ...toOptions(statuses),
          ]}
        />
        <Select name="domain" label="Domain" value={filter.domain} options={[{ value: "", text: "All" }, { value: "none", text: "No domain" }, ...toOptions(domains)]} />
        <Select
          name="due"
          label="Due"
          value={filter.due}
          options={[
            { value: "", text: "Any time" },
            { value: "overdue", text: "Overdue" },
            { value: "week", text: "Within 7 days" },
            { value: "none", text: "No due date" },
          ]}
        />
        <Select
          name="sort"
          label="Sort by"
          value={filter.sort}
          options={[
            { value: "due", text: "Due date" },
            { value: "status", text: "Status" },
            { value: "updated", text: "Recently updated" },
            { value: "created", text: "Recently created" },
            { value: "title", text: "Title" },
          ]}
        />
        <Button variant="secondary">Apply</Button>
      </form>

      <p class="govuk-body lg-muted">
        {tasks.length} {tasks.length === 1 ? "task" : "tasks"}
      </p>
      {tasks.length > 0 && (
        <table class="govuk-table lg-table">
          <thead class="govuk-table__head">
            <tr class="govuk-table__row">
              <th scope="col" class="govuk-table__header">Task</th>
              <th scope="col" class="govuk-table__header">Domains</th>
              <th scope="col" class="govuk-table__header">Status</th>
              <th scope="col" class="govuk-table__header">Timeline</th>
              <th scope="col" class="govuk-table__header">Assigned</th>
              <th scope="col" class="govuk-table__header">Due by</th>
            </tr>
          </thead>
          <tbody class="govuk-table__body">
            {tasks.map((t) => (
              <tr class="govuk-table__row">
                <td class="govuk-table__cell">
                  <a class="govuk-link" href={`/tasks/${t.id}`} data-modal>
                    {t.title}
                  </a>
                </td>
                <td class="govuk-table__cell lg-tags">
                  <DomainTag t={t} />
                </td>
                <td class="govuk-table__cell">
                  <StatusTag t={t} />
                </td>
                <td class="govuk-table__cell">{t.timeline}</td>
                <td class="govuk-table__cell lg-nowrap">{fmtDate(t.assigned_at)}</td>
                <td class="govuk-table__cell lg-nowrap">
                  <Due t={t} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>,
  );
});

// ---------------------------------------------------------------- board

taskRoutes.get("/board", (c) => {
  const user = c.get("user");
  const domain = c.req.query("domain") ?? "";
  const statuses = listCategories("statuses", user.id);
  const domains = listCategories("domains", user.id);
  const cutoff = new Date(Date.now() - CLOSED_COLUMN_DAYS * 86_400_000).toISOString();
  const all = listTasks(user.id, { status: "all", domain, sort: "status" });

  return page(
    c,
    { title: "Task board", nav: "tasks", wide: true },
    <>
      <div class="lg-title-row">
        <h1 class="govuk-heading-l">Task board</h1>
        <ButtonGroup>
          <ButtonLink href="/tasks/new" modal>
            Add a task
          </ButtonLink>
          <ButtonLink href="/tasks" variant="secondary">
            View as list
          </ButtonLink>
        </ButtonGroup>
      </div>
      <form method="get" action="/tasks/board" class="lg-filters">
        <Select name="domain" label="Domain" value={domain} options={[{ value: "", text: "All" }, { value: "none", text: "No domain" }, ...toOptions(domains)]} />
        <Button variant="secondary">Apply</Button>
        <p class="govuk-body lg-filters__links">
          <a class="govuk-link" href="/settings/statuses" data-modal>
            Edit statuses
          </a>
          <a class="govuk-link" href="/settings/domains" data-modal>
            Edit domains
          </a>
        </p>
      </form>

      <div class="lg-board" data-board style={`--lg-cols: ${statuses.length}`}>
        {statuses.map((s) => {
          const inCol = all.filter((t) => t.status_id === s.id);
          const shown = s.is_closed ? inCol.filter((t) => t.updated_at >= cutoff) : inCol;
          const hidden = inCol.length - shown.length;
          return (
            <section class="lg-column" aria-labelledby={`col-${s.id}`}>
              <h2 class="lg-column__title" id={`col-${s.id}`}>
                <Tag colour={s.colour}>{s.name}</Tag>
                <span class="lg-column__count">{inCol.length}</span>
              </h2>
              <ol class="lg-column__list" data-status-id={s.id}>
                {shown.map((t) => (
                  <li class="lg-card" draggable="true" data-id={t.id}>
                    <a class="govuk-link lg-card__title" href={`/tasks/${t.id}`} data-modal>
                      {t.title}
                    </a>
                    <div class="lg-card__meta">
                      <DomainTag t={t} />
                      {t.timeline && <span class="lg-card__timeline">{t.timeline}</span>}
                    </div>
                    {t.due_by && (
                      <p class={`lg-card__due${isOverdue(t) ? " lg-card__due--overdue" : ""}`}>
                        {isOverdue(t) ? "Overdue: " : "Due "}
                        {fmtDate(t.due_by)}
                      </p>
                    )}
                    <form method="post" action={`/tasks/${t.id}/status`} class="lg-card__move">
                      <input type="hidden" name="back" value={`/tasks/board${domain ? `?domain=${domain}` : ""}`} />
                      <label class="govuk-visually-hidden" for={`move-${t.id}`}>
                        Status of {t.title}
                      </label>
                      <select class="govuk-select lg-select--small" id={`move-${t.id}`} name="status_id">
                        {statuses.map((o) => (
                          <option value={String(o.id)} selected={o.id === t.status_id}>
                            {o.name}
                          </option>
                        ))}
                      </select>
                      <button type="submit" class="govuk-button govuk-button--secondary lg-button--small">
                        Move
                      </button>
                    </form>
                  </li>
                ))}
              </ol>
              {hidden > 0 && (
                <p class="govuk-body-s lg-column__more">
                  <a class="govuk-link" href={`/tasks?status=${s.id}`}>
                    {hidden} older in {s.name}
                  </a>
                </p>
              )}
              {!s.is_closed && (
                <p class="govuk-body-s lg-column__add">
                  <a class="govuk-link" href={`/tasks/new?status=${s.id}`} data-modal>
                    Add a task<span class="govuk-visually-hidden"> to {s.name}</span>
                  </a>
                </p>
              )}
            </section>
          );
        })}
        <section class="lg-column lg-column--new" aria-labelledby="col-new">
          <form method="post" action="/settings/statuses" novalidate>
            <input type="hidden" name="back" value="/tasks/board" />
            <label class="govuk-label govuk-label--s" id="col-new" for="new-status">
              Add a status
            </label>
            <input class="govuk-input" id="new-status" name="name" type="text" autocomplete="off" />
            <button type="submit" class="govuk-button govuk-button--secondary lg-button--small">
              Add column
            </button>
          </form>
        </section>
      </div>
    </>,
  );
});

// ---------------------------------------------------------------- create / edit

/** Validates a task form. New domains named in it are created only when it is valid. */
function parseTask(c: Ctx, f: Form): { input: TaskInput; errors: Errors } {
  const user = c.get("user");
  const errors: Errors = {};
  const statuses = listCategories("statuses", user.id);
  if (!f.title) errors.title = "Enter a title";
  else if (f.title.length > 200) errors.title = "Title must be 200 characters or fewer";
  const statusId = Number(f.status_id);
  if (!statuses.some((s) => s.id === statusId)) errors.status_id = "Select a status";
  const domainFields = readDomainFields(user.id, f);
  Object.assign(errors, domainFields.errors);
  if (f.assigned_at && !isDate(f.assigned_at)) errors.assigned_at = "Assigned date must be a real date";
  if (f.due_by && !isDate(f.due_by)) errors.due_by = "Due date must be a real date";
  if (f.timeline && f.timeline.length > 100) errors.timeline = "Timeline must be 100 characters or fewer";
  const valid = Object.keys(errors).length === 0;
  return {
    errors,
    input: {
      title: f.title ?? "",
      description: f.description ?? "",
      domain_ids: valid ? [...new Set([...domainFields.ids, ...ensureDomains(user.id, domainFields.newNames)])] : [],
      timeline: f.timeline ?? "",
      status_id: statusId,
      assigned_at: f.assigned_at || null,
      due_by: f.due_by || null,
    },
  };
}

function taskForm(c: Ctx, opts: { task?: Task; values: Form; errors?: Errors }) {
  const user = c.get("user");
  const errors = opts.errors ?? {};
  const v = opts.values;
  const statuses = listCategories("statuses", user.id);
  const domains = listCategories("domains", user.id);
  const title = opts.task ? `Change ${opts.task.title}` : "Add a task";
  return page(
    c,
    { title, nav: "tasks", error: Object.keys(errors).length > 0 },
    <div class="govuk-grid-row">
      <div class="govuk-grid-column-two-thirds">
        <BackLink href={opts.task ? `/tasks/${opts.task.id}` : "/tasks/board"} />
        <ErrorSummary errors={errors} />
        <span class="govuk-caption-l">Tasks</span>
        <h1 class="govuk-heading-l">{opts.task ? "Change task" : "Add a task"}</h1>
        <form method="post" action={opts.task ? `/tasks/${opts.task.id}` : "/tasks"} novalidate>
          <Input name="title" label="Title" value={v.title} error={errors.title} />
          <Textarea name="description" label="Description" hint="You can use Markdown." value={v.description} error={errors.description} />
          <DomainPicker domains={domains} selected={v.domain_ids} newValue={v.new_domains} error={errors.domain_ids} newError={errors.new_domains} />
          <div class="lg-field-row">
            <Select name="status_id" label="Status" value={v.status_id} error={errors.status_id} options={toOptions(statuses)} />
            <Input name="timeline" label="Timeline" hint="For example, Sprint 42, Q4 or this week" value={v.timeline} error={errors.timeline} width="20" />
          </div>
          <div class="lg-field-row">
            <Input name="assigned_at" label="Assigned on" type="date" value={v.assigned_at} error={errors.assigned_at} width="10" />
            <Input name="due_by" label="Due by" type="date" value={v.due_by} error={errors.due_by} width="10" />
          </div>
          <ButtonGroup>
            <Button>{opts.task ? "Save changes" : "Add task"}</Button>
            <a class="govuk-link" href={opts.task ? `/tasks/${opts.task.id}` : "/tasks/board"} data-close={opts.task ? undefined : true}>
              Cancel
            </a>
          </ButtonGroup>
        </form>
      </div>
    </div>,
  );
}

taskRoutes.get("/new", (c) => {
  const statuses = listCategories("statuses", c.get("user").id);
  const wanted = Number(c.req.query("status"));
  const status = statuses.find((s) => s.id === wanted) ?? statuses.find((s) => !s.is_closed) ?? statuses[0];
  return taskForm(c, { values: { status_id: String(status?.id ?? ""), assigned_at: localDate() } });
});

taskRoutes.post("/", async (c) => {
  const f = await form(c);
  const { input, errors } = parseTask(c, f);
  if (Object.keys(errors).length) {
    c.status(400);
    return taskForm(c, { values: f, errors });
  }
  const user = c.get("user");
  const id = createTask(user.id, input);
  audit(user.id, "task added", input.title, c.get("ip"));
  flash(c, "Task added");
  return c.redirect(`/tasks/${id}`);
});

taskRoutes.get("/:id", (c) => {
  const user = c.get("user");
  const t = getTask(user.id, intParam(c));
  if (!t) return c.notFound();
  const history = taskHistory(user.id, t.id);
  const statuses = listCategories("statuses", user.id);
  return page(
    c,
    { title: t.title, nav: "tasks" },
    <div class="govuk-grid-row">
      <div class="govuk-grid-column-two-thirds">
        <BackLink href="/tasks/board" text="Task board" />
        <span class="govuk-caption-l">
          Task{t.domains.length > 0 && <> · {t.domains.map((d) => d.name).join(", ")}</>}
        </span>
        <h1 class="govuk-heading-l">{t.title}</h1>
        {isOverdue(t) && <WarningText>This task was due on {fmtDate(t.due_by)}.</WarningText>}
        <SummaryList
          rows={[
            { key: "Status", value: <StatusTag t={t} /> },
            { key: t.domains.length === 1 ? "Domain" : "Domains", value: t.domains.length ? <span class="lg-tags"><DomainTag t={t} /></span> : "None" },
            { key: "Timeline", value: t.timeline || "Not set" },
            { key: "Assigned on", value: fmtDate(t.assigned_at) || "Not set" },
            { key: "Due by", value: t.due_by ? <Due t={t} /> : "Not set" },
            { key: "Created", value: fmtDateTime(t.created_at) },
            { key: "Last updated", value: fmtDateTime(t.updated_at) },
          ]}
        />
        <h2 class="govuk-heading-m">Description</h2>
        <Markdown src={t.description} />

        <ButtonGroup>
          <ButtonLink href={`/tasks/${t.id}/edit`} variant="secondary">
            Change task
          </ButtonLink>
          <a class="govuk-link lg-link--warning" href={`/tasks/${t.id}/delete`}>
            Delete task
          </a>
        </ButtonGroup>
      </div>

      <div class="govuk-grid-column-one-third">
        <form method="post" action={`/tasks/${t.id}/status`} class="lg-side-form">
          <input type="hidden" name="back" value={`/tasks/${t.id}`} />
          <Select name="status_id" label="Move to" value={String(t.status_id)} options={toOptions(statuses)} />
          <Button variant="secondary">Update status</Button>
        </form>
        <h2 class="govuk-heading-s">History</h2>
        <ol class="lg-timeline">
          {history.map((e) => (
            <li class="lg-timeline__item">
              <p class="govuk-body-s lg-muted lg-timeline__when">{fmtDateTime(e.at)}</p>
              <p class="govuk-body-s">
                {e.from_name ? (
                  <>
                    <Tag colour={e.from_colour ?? "grey"}>{e.from_name}</Tag> → <Tag colour={e.to_colour}>{e.to_name}</Tag>
                  </>
                ) : (
                  <>
                    Created in <Tag colour={e.to_colour}>{e.to_name}</Tag>
                  </>
                )}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </div>,
  );
});

taskRoutes.get("/:id/edit", (c) => {
  const t = getTask(c.get("user").id, intParam(c));
  if (!t) return c.notFound();
  return taskForm(c, {
    task: t,
    values: {
      title: t.title,
      description: t.description,
      domain_ids: t.domains.map((d) => d.id).join(","),
      status_id: String(t.status_id),
      timeline: t.timeline,
      assigned_at: t.assigned_at ?? "",
      due_by: t.due_by ?? "",
    },
  });
});

taskRoutes.post("/:id", async (c) => {
  const user = c.get("user");
  const t = getTask(user.id, intParam(c));
  if (!t) return c.notFound();
  const f = await form(c);
  const { input, errors } = parseTask(c, f);
  if (Object.keys(errors).length) {
    c.status(400);
    return taskForm(c, { task: t, values: f, errors });
  }
  updateTask(user.id, t.id, input);
  audit(user.id, "task changed", input.title, c.get("ip"));
  flash(c, "Task saved");
  return c.redirect(`/tasks/${t.id}`);
});

/** From the board (JSON, with the column's new order) or a plain form. */
taskRoutes.post("/:id/status", async (c) => {
  const user = c.get("user");
  const id = intParam(c);
  if (c.req.header("content-type")?.startsWith("application/json")) {
    const body = (await c.req.json().catch(() => ({}))) as { status_id?: number; order?: number[] };
    const order = Array.isArray(body.order) ? body.order.map(Number).filter(Number.isInteger) : undefined;
    const ok = setStatus(user.id, id, Number(body.status_id), order);
    return c.json({ ok }, ok ? 200 : 400);
  }
  const f = await form(c);
  const t = getTask(user.id, id);
  if (!t || !setStatus(user.id, id, Number(f.status_id))) return c.notFound();
  const after = getTask(user.id, id)!;
  if (after.status_id !== t.status_id) flash(c, `${t.title} moved to ${after.status_name}`);
  return c.redirect(safeNext(f.back, `/tasks/${id}`));
});

taskRoutes.get("/:id/delete", (c) => {
  const t = getTask(c.get("user").id, intParam(c));
  if (!t) return c.notFound();
  return page(
    c,
    { title: `Delete ${t.title}`, nav: "tasks" },
    <div class="govuk-grid-row">
      <div class="govuk-grid-column-two-thirds">
        <BackLink href={`/tasks/${t.id}`} />
        <h1 class="govuk-heading-l">Are you sure you want to delete {t.title}?</h1>
        <p class="govuk-body">It will be removed from the board, the list and your journal days.</p>
        <form method="post" action={`/tasks/${t.id}/delete`}>
          <ButtonGroup>
            <Button variant="warning">Yes, delete task</Button>
            <a class="govuk-link" href={`/tasks/${t.id}`}>
              No, keep it
            </a>
          </ButtonGroup>
        </form>
      </div>
    </div>,
  );
});

taskRoutes.post("/:id/delete", (c) => {
  const user = c.get("user");
  const t = getTask(user.id, intParam(c));
  if (!t) return c.notFound();
  deleteTask(user.id, t.id);
  audit(user.id, "task deleted", t.title, c.get("ip"));
  flash(c, `${t.title} deleted`);
  return c.redirect("/tasks/board");
});
