import { Hono } from "hono";
import type { FC } from "hono/jsx";
import { audit } from "../auth.ts";
import { dayBounds, db, localDate } from "../db.ts";
import {
  distanceM,
  fmtCoords,
  type HelperState,
  helperAlive,
  helperState,
  MAX_RADIUS,
  MIN_RADIUS,
  parseCoords,
} from "../location/geofence.ts";
import { searchPlaces } from "../location/search.ts";
import {
  createPlace,
  deletePlace,
  getPlace,
  listPlaces,
  type Place,
  type PlaceInput,
  placeNameTaken,
  setLogging,
  updatePlace,
  type Visit,
  visitMs,
  visits,
  weeklyTotals,
} from "../places.ts";
import {
  ActionForm,
  BackLink,
  Button,
  ButtonGroup,
  ButtonLink,
  ErrorSummary,
  type Errors,
  fmtDate,
  fmtDateTime,
  fmtDuration,
  fmtShortDate,
  fmtTime,
  Input,
  InsetText,
  Select,
  SummaryCard,
  SummaryList,
  Tag,
  WarningText,
} from "../views/components.tsx";
import { type Ctx, type Env, type Form, flash, form, intParam, page } from "../web.tsx";

export const placeRoutes = new Hono<Env>();

const DEFAULT_RADIUS = 150;

const LoggingTag = ({ p }: { p: Place }) =>
  p.logging_enabled ? <Tag colour="green">Logging on</Tag> : <Tag colour="grey">Logging off</Tag>;

const fmtMetres = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

/** Where the helper last put you, for the map's "you are here" dot. */
const hereData = (s: HelperState) =>
  helperAlive(s) && hasFix(s) ? { "data-here-lat": String(s.lat), "data-here-lon": String(s.lon) } : {};

const mapLink = (lat: number, lon: number) => `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`;

const hasFix = (s: HelperState): s is HelperState & { lat: number; lon: number } => s.lat !== null && s.lon !== null;

/** Inside the geofence by the helper's latest fix, whether or not logging is on. */
const insideNow = (p: Place, s: HelperState) =>
  helperAlive(s) && hasFix(s) && p.lat !== null && p.lon !== null && distanceM(p.lat, p.lon, s.lat, s.lon) <= p.radius_m;

/** What the Ledger Locator helper is doing, and what to do about it. */
const LocatorStatus: FC<{ s: HelperState; here: Place[] }> = ({ s, here }) => {
  if (!s.last_seen_at) {
    return (
      <InsetText>
        Ledger Locator is not running, so no visits are being logged. Install it with{" "}
        <code class="lg-code">bin/ledger install-helper</code> and allow it to use your location when macOS asks.
      </InsetText>
    );
  }
  if (s.auth_status === "denied" || s.auth_status === "restricted") {
    return (
      <WarningText>
        Ledger Locator is not allowed to use your location. Allow it in System Settings, Privacy and Security, Location Services.
      </WarningText>
    );
  }
  if (s.auth_status === "disabled") {
    return <WarningText>Location Services are turned off, so no visits are being logged.</WarningText>;
  }
  if (s.auth_status === "notDetermined") {
    return <InsetText>Ledger Locator is waiting for you to allow it to use your location.</InsetText>;
  }
  if (!helperAlive(s)) {
    return (
      <InsetText>
        Ledger Locator last checked in {fmtDateTime(s.last_seen_at)}. The computer may have been asleep, or the helper has stopped. Visits
        resume when it checks in again.
      </InsetText>
    );
  }
  const notLogged = here.filter((p) => !p.logging_enabled);
  return (
    <InsetText>
      {here.length ? (
        <>
          You are at <strong>{here.map((p) => p.name).join(" and ")}</strong>.
          {notLogged.length > 0 && <> Logging is off for {notLogged.map((p) => p.name).join(" and ")}, so this visit is not being recorded.</>}
        </>
      ) : (
        "You are not at any of your places."
      )}
      {s.located_at && s.accuracy_m !== null && (
        <>
          {" "}
          Location accurate to about {fmtMetres(s.accuracy_m)}, updated {fmtTime(s.located_at)}.
        </>
      )}
    </InsetText>
  );
};

function VisitsTable({ rows, showPlace }: { rows: Visit[]; showPlace?: boolean }) {
  return (
    <table class="govuk-table">
      <thead class="govuk-table__head">
        <tr class="govuk-table__row">
          {showPlace && <th scope="col" class="govuk-table__header">Place</th>}
          <th scope="col" class="govuk-table__header">Day</th>
          <th scope="col" class="govuk-table__header">Arrived</th>
          <th scope="col" class="govuk-table__header">Left</th>
          <th scope="col" class="govuk-table__header">Time there</th>
        </tr>
      </thead>
      <tbody class="govuk-table__body">
        {rows.map((v) => (
          <tr class="govuk-table__row">
            {showPlace && (
              <td class="govuk-table__cell">
                <a class="govuk-link" href={`/places/${v.place_id}`}>
                  {v.place_name}
                </a>
              </td>
            )}
            <td class="govuk-table__cell lg-nowrap">
              <a class="govuk-link" href={`/journal/day/${localDate(new Date(v.entered_at))}`}>
                {fmtDate(v.entered_at)}
              </a>
            </td>
            <td class="govuk-table__cell">{fmtTime(v.entered_at)}</td>
            <td class="govuk-table__cell">
              {v.exited_at ? (
                localDate(new Date(v.exited_at)) === localDate(new Date(v.entered_at)) ? (
                  fmtTime(v.exited_at)
                ) : (
                  fmtDateTime(v.exited_at)
                )
              ) : (
                <Tag colour="green">Here now</Tag>
              )}
            </td>
            <td class="govuk-table__cell">{fmtDuration(visitMs(v))}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------- list

placeRoutes.get("/", (c) => {
  const user = c.get("user");
  const places = listPlaces(user.id);
  const s = helperState(db());
  const [from, to] = dayBounds(localDate());
  const todayMs = new Map<number, number>();
  for (const v of visits(user.id, { from, to })) todayMs.set(v.place_id, (todayMs.get(v.place_id) ?? 0) + visitMs(v, from, to));

  return page(
    c,
    { title: "My locations", nav: "places" },
    <>
      <div class="lg-title-row">
        <h1 class="govuk-heading-l">My locations</h1>
        <ButtonGroup>
          <ButtonLink href="/places/new">Add a place</ButtonLink>
          <ButtonLink href="/places/log" variant="secondary">
            Location log
          </ButtonLink>
        </ButtonGroup>
      </div>

      <div class="govuk-grid-row">
        <div class="govuk-grid-column-two-thirds">
          <LocatorStatus s={s} here={places.filter((p) => p.here_since || insideNow(p, s))} />
        </div>
      </div>

      {places.length === 0 ? (
        <p class="govuk-body">You have not added any places yet.</p>
      ) : (
        <table class="govuk-table">
          <thead class="govuk-table__head">
            <tr class="govuk-table__row">
              <th scope="col" class="govuk-table__header">Place</th>
              <th scope="col" class="govuk-table__header">Now</th>
              <th scope="col" class="govuk-table__header">Today</th>
              <th scope="col" class="govuk-table__header">Geofence</th>
              <th scope="col" class="govuk-table__header">Logging</th>
            </tr>
          </thead>
          <tbody class="govuk-table__body">
            {places.map((p) => (
              <tr class="govuk-table__row">
                <td class="govuk-table__cell">
                  <a class="govuk-link" href={`/places/${p.id}`}>
                    {p.name}
                  </a>
                </td>
                <td class="govuk-table__cell">
                  {p.here_since ? (
                    <Tag colour="green">Here since {fmtTime(p.here_since)}</Tag>
                  ) : insideNow(p, s) ? (
                    <Tag colour="grey">{p.logging_enabled ? "Here, logging shortly" : "Here, not logging"}</Tag>
                  ) : (
                    ""
                  )}
                </td>
                <td class="govuk-table__cell">{todayMs.get(p.id) ? fmtDuration(todayMs.get(p.id)!) : ""}</td>
                <td class="govuk-table__cell">{p.lat !== null ? `${fmtMetres(p.radius_m)} radius` : <Tag colour="orange">Not set</Tag>}</td>
                <td class="govuk-table__cell lg-actions">
                  <LoggingTag p={p} />
                  <ActionForm action={`/places/${p.id}/logging`} link hidden={{ on: p.logging_enabled ? "0" : "1", back: "/places" }}>
                    {p.logging_enabled ? "Turn off" : "Turn on"}
                    <span class="govuk-visually-hidden"> logging for {p.name}</span>
                  </ActionForm>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>,
  );
});

// ---------------------------------------------------------------- log

placeRoutes.get("/log", (c) => {
  const user = c.get("user");
  const places = listPlaces(user.id);
  const placeId = Number(c.req.query("place")) || undefined;
  const rows = visits(user.id, { placeId, limit: 300 });
  return page(
    c,
    { title: "Location log", nav: "places" },
    <>
      <BackLink href="/places" text="My locations" />
      <h1 class="govuk-heading-l">Location log</h1>
      <form method="get" action="/places/log" class="lg-filters">
        <Select
          name="place"
          label="Place"
          value={placeId ? String(placeId) : ""}
          options={[{ value: "", text: "All places" }, ...places.map((p) => ({ value: String(p.id), text: p.name }))]}
        />
        <Button variant="secondary">Apply</Button>
      </form>
      {rows.length === 0 ? <p class="govuk-body">No visits logged yet.</p> : <VisitsTable rows={rows} showPlace />}
    </>,
  );
});

// ---------------------------------------------------------------- add / change

function parsePlace(userId: number, f: Form, exceptId = 0): { input: PlaceInput; errors: Errors } {
  const errors: Errors = {};
  if (!f.name) errors.name = "Enter a name for the place";
  else if (f.name.length > 60) errors.name = "Name must be 60 characters or fewer";
  else if (placeNameTaken(userId, f.name, exceptId)) errors.name = `You already have a place called ${f.name}`;

  const coords = f.coords ? parseCoords(f.coords) : undefined;
  if (!f.coords) errors.coords = "Enter the place’s coordinates, or use your current location";
  else if (!coords) errors.coords = "Enter coordinates as latitude, longitude, for example 12.9716, 77.5946";

  const radius = Number(f.radius);
  if (!f.radius) errors.radius = "Enter a radius in metres";
  else if (!Number.isInteger(radius) || radius < MIN_RADIUS || radius > MAX_RADIUS) {
    errors.radius = `Radius must be a whole number of metres between ${MIN_RADIUS} and ${MAX_RADIUS}`;
  }
  return {
    errors,
    input: { name: f.name ?? "", lat: coords?.lat ?? null, lon: coords?.lon ?? null, radius_m: radius },
  };
}

function placeForm(c: Ctx, opts: { place?: Place; values: Form; errors?: Errors; located?: boolean }) {
  const errors = opts.errors ?? {};
  const v = opts.values;
  const s = helperState(db());
  const action = opts.place ? `/places/${opts.place.id}` : "/places";
  const back = opts.place ? `/places/${opts.place.id}` : "/places";
  return page(
    c,
    { title: opts.place ? `Change ${opts.place.name}` : "Add a place", nav: "places", map: true, error: Object.keys(errors).length > 0 },
    <>
      <div class="govuk-grid-row">
        <div class="govuk-grid-column-two-thirds">
          <BackLink href={back} />
          <ErrorSummary errors={errors} />
          <span class="govuk-caption-l">My locations</span>
          <h1 class="govuk-heading-l">{opts.place ? `Change ${opts.place.name}` : "Add a place"}</h1>
          {opts.located && s.located_at && (
            <InsetText>
              Filled in your location from {fmtTime(s.located_at)}
              {s.accuracy_m !== null && <>, accurate to about {fmtMetres(s.accuracy_m)}</>}.
            </InsetText>
          )}
        </div>
      </div>
      <form method="post" action={action} novalidate>
        {/* Enter submits the first button in a form; make that Save, not "Use my current location". */}
        <button type="submit" class="govuk-visually-hidden" tabindex={-1} aria-hidden="true">
          Save
        </button>
        <div class="govuk-grid-row">
          <div class="govuk-grid-column-two-thirds">
            <Input name="name" label="Name" hint="For example, Office, Home or Client site" value={v.name} error={errors.name} width="20" />
            <div class="govuk-form-group lg-search lg-js-only">
              <label class="govuk-label govuk-label--s" for="place-search">
                Search for an address or place
              </label>
              <div id="place-search-hint" class="govuk-hint">
                Or click the map to drop the pin, and drag it to adjust.
              </div>
              <input
                class="govuk-input"
                id="place-search"
                type="search"
                autocomplete="off"
                spellcheck={false}
                aria-describedby="place-search-hint place-search-status"
              />
              <div id="place-results" class="lg-search__results" hidden></div>
              <p id="place-search-status" class="govuk-body-s lg-muted lg-search__status" aria-live="polite"></p>
            </div>
          </div>
        </div>
        <div id="place-map" class="lg-map lg-js-only" data-editable="1" {...hereData(s)}></div>
        <p class="govuk-body-s lg-muted lg-js-only">
          Map tiles come from OpenFreeMap and VersaTiles, and searches go to OpenStreetMap’s Nominatim. Your places are not sent anywhere.
        </p>
        <div class="govuk-grid-row">
          <div class="govuk-grid-column-two-thirds">
            <Input
              name="coords"
              label="Coordinates"
              hint="Set by the map, or paste latitude, longitude. In Google Maps, right-click a spot and click the numbers to copy them."
              value={v.coords}
              error={errors.coords}
              width="20"
              spellcheck={false}
            />
            {hasFix(s) && (
              <button type="submit" name="locate" value="1" class="govuk-button govuk-button--secondary lg-button--small lg-locate">
                Use my current location
              </button>
            )}
            <Input
              name="radius"
              label="Radius in metres"
              hint="Location is usually accurate to between 20 and 100 metres, so a smaller geofence may miss some visits."
              value={v.radius}
              error={errors.radius}
              width="5"
              type="number"
            />
            <ButtonGroup>
              <Button>{opts.place ? "Save changes" : "Add place"}</Button>
              <a class="govuk-link" href={back}>
                Cancel
              </a>
            </ButtonGroup>
          </div>
        </div>
      </form>
    </>,
  );
}

/** "Use my current location" re-shows the form with the helper's last fix. */
function withCurrentLocation(f: Form): Form {
  const s = helperState(db());
  return hasFix(s) ? { ...f, coords: fmtCoords(s.lat, s.lon) } : f;
}

placeRoutes.get("/new", (c) => placeForm(c, { values: { radius: String(DEFAULT_RADIUS) } }));

placeRoutes.post("/", async (c) => {
  const user = c.get("user");
  const f = await form(c);
  if (f.locate) return placeForm(c, { values: withCurrentLocation(f), located: true });
  const { input, errors } = parsePlace(user.id, f);
  if (Object.keys(errors).length) {
    c.status(400);
    return placeForm(c, { values: f, errors });
  }
  const id = createPlace(user.id, input);
  audit(user.id, "place added", input.name, c.get("ip"));
  flash(c, `${input.name} added`);
  return c.redirect(`/places/${id}`);
});

placeRoutes.get("/search", async (c) => {
  try {
    return c.json(await searchPlaces(c.req.query("q") ?? ""));
  } catch (e) {
    console.error(`place search: ${(e as Error).message}`);
    return c.json({ error: "Search is unavailable" }, 502);
  }
});

placeRoutes.get("/:id", (c) => {
  const user = c.get("user");
  const p = getPlace(user.id, intParam(c));
  if (!p) return c.notFound();
  const s = helperState(db());
  const weeks = weeklyTotals(user.id, p.id);
  const recent = visits(user.id, { placeId: p.id, limit: 20 });
  const away = p.lat !== null && p.lon !== null && hasFix(s) ? distanceM(p.lat, p.lon, s.lat, s.lon) : undefined;

  return page(
    c,
    { title: p.name, nav: "places", map: p.lat !== null },
    <div class="govuk-grid-row">
      <div class="govuk-grid-column-two-thirds">
        <BackLink href="/places" text="My locations" />
        <span class="govuk-caption-l">My locations</span>
        <h1 class="govuk-heading-l">{p.name}</h1>

        <SummaryList
          rows={[
            { key: "Name", value: p.name, action: { href: `/places/${p.id}/edit`, text: "Change" } },
            {
              key: "Geofence",
              value:
                p.lat !== null && p.lon !== null ? (
                  <>
                    {fmtMetres(p.radius_m)} around {fmtCoords(p.lat, p.lon)}
                    <br />
                    <a class="govuk-link" href={mapLink(p.lat, p.lon)} target="_blank" rel="noreferrer noopener">
                      View on OpenStreetMap<span class="govuk-visually-hidden"> (opens in new tab)</span>
                    </a>
                  </>
                ) : (
                  <Tag colour="orange">Not set</Tag>
                ),
              action: { href: `/places/${p.id}/edit`, text: "Change" },
            },
            ...(away !== undefined
              ? [
                  {
                    key: "You",
                    value: `${fmtMetres(away)} from the centre, ${away <= p.radius_m ? "inside" : "outside"} the geofence`,
                  },
                ]
              : []),
            { key: "Logging", value: <LoggingTag p={p} /> },
            {
              key: "Now",
              value: p.here_since
                ? `Here since ${fmtDateTime(p.here_since)}`
                : !insideNow(p, s)
                  ? "Not here"
                  : p.logging_enabled
                    ? "Here. The visit is logged when Ledger Locator next checks in, within a minute."
                    : "Here, but logging is off",
            },
          ]}
        />
        {p.lat !== null && p.lon !== null && (
          <div
            id="place-map"
            class="lg-map lg-map--small lg-js-only"
            data-lat={String(p.lat)}
            data-lon={String(p.lon)}
            data-radius={String(p.radius_m)}
            {...hereData(s)}
          ></div>
        )}
        <ActionForm action={`/places/${p.id}/logging`} variant="secondary" hidden={{ on: p.logging_enabled ? "0" : "1" }}>
          {p.logging_enabled ? "Turn off entry and exit logging" : "Turn on entry and exit logging"}
        </ActionForm>

        <h2 class="govuk-heading-m">Recent visits</h2>
        {recent.length === 0 ? <p class="govuk-body">No visits logged yet.</p> : <VisitsTable rows={recent} />}
        <p class="govuk-body">
          <a class="govuk-link" href={`/places/log?place=${p.id}`}>
            See all visits to {p.name}
          </a>
        </p>
        <p class="govuk-body">
          <a class="govuk-link lg-link--warning" href={`/places/${p.id}/delete`}>
            Delete this place
          </a>
        </p>
      </div>

      <div class="govuk-grid-column-one-third">
        <SummaryCard title="Hours by week">
          <SummaryList
            noBorder
            rows={weeks.map(([start, ms]) => ({ key: `Week of ${fmtShortDate(start)}`, value: ms ? fmtDuration(ms) : "None" }))}
          />
        </SummaryCard>
      </div>
    </div>,
  );
});

placeRoutes.get("/:id/edit", (c) => {
  const p = getPlace(c.get("user").id, intParam(c));
  if (!p) return c.notFound();
  return placeForm(c, {
    place: p,
    values: { name: p.name, coords: p.lat !== null && p.lon !== null ? fmtCoords(p.lat, p.lon) : "", radius: String(p.radius_m) },
  });
});

placeRoutes.post("/:id", async (c) => {
  const user = c.get("user");
  const p = getPlace(user.id, intParam(c));
  if (!p) return c.notFound();
  const f = await form(c);
  if (f.locate) return placeForm(c, { place: p, values: withCurrentLocation(f), located: true });
  const { input, errors } = parsePlace(user.id, f, p.id);
  if (Object.keys(errors).length) {
    c.status(400);
    return placeForm(c, { place: p, values: f, errors });
  }
  updatePlace(user.id, p.id, input);
  audit(user.id, "place changed", input.name, c.get("ip"));
  flash(c, `${input.name} saved`);
  return c.redirect(`/places/${p.id}`);
});

placeRoutes.post("/:id/logging", async (c) => {
  const user = c.get("user");
  const p = getPlace(user.id, intParam(c));
  if (!p) return c.notFound();
  const f = await form(c);
  const on = f.on === "1";
  setLogging(user.id, p.id, on);
  audit(user.id, on ? "logging on" : "logging off", p.name, c.get("ip"));
  flash(c, `Logging turned ${on ? "on" : "off"} for ${p.name}`);
  return c.redirect(f.back === "/places" ? "/places" : `/places/${p.id}`);
});

placeRoutes.get("/:id/delete", (c) => {
  const p = getPlace(c.get("user").id, intParam(c));
  if (!p) return c.notFound();
  return page(
    c,
    { title: `Delete ${p.name}`, nav: "places" },
    <div class="govuk-grid-row">
      <div class="govuk-grid-column-two-thirds">
        <BackLink href={`/places/${p.id}`} />
        <h1 class="govuk-heading-l">Are you sure you want to delete {p.name}?</h1>
        <p class="govuk-body">Ledger will stop logging visits here. Visits already logged stay in the location log.</p>
        <form method="post" action={`/places/${p.id}/delete`}>
          <ButtonGroup>
            <Button variant="warning">Yes, delete place</Button>
            <a class="govuk-link" href={`/places/${p.id}`}>
              No, keep it
            </a>
          </ButtonGroup>
        </form>
      </div>
    </div>,
  );
});

placeRoutes.post("/:id/delete", (c) => {
  const user = c.get("user");
  const p = getPlace(user.id, intParam(c));
  if (!p) return c.notFound();
  deletePlace(user.id, p.id);
  audit(user.id, "place deleted", p.name, c.get("ip"));
  flash(c, `${p.name} deleted`);
  return c.redirect("/places");
});
