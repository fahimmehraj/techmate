import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import FullCalendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import "./styles.css";

type Attendee = { id: string; displayName: string; readiness: "ready" | "needs_invite_email" | "needs_availability" | "unverified" };
type PlannerSession = { id: string; title?: string; selectedTime?: { startsAt: string; endsAt: string }; availabilityOverride: boolean; status: string; expiresAt: string };
type Guest = { displayName: string; email: string };
type State = { session: PlannerSession; attendees: Attendee[]; guests: Guest[] };
type BusyResponse = { attendees: Array<Attendee & { busy: Array<{ startsAt: string; endsAt: string }> }> };

const colors = ["#6750a4", "#006d77", "#b54708", "#b42318", "#1d4ed8", "#7e22ce", "#047857"];

async function responseError(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = await response.json().catch(() => undefined) as { message?: unknown } | undefined;
    if (typeof body?.message === "string" && body.message.trim()) return body.message;
    return `The server could not complete that request (HTTP ${response.status}).`;
  }

  const body = (await response.text()).trim();
  if (!body || body.includes("__bunfallback") || /<!doctype html/i.test(body)) {
    return "The server could not complete that request. Check the API log and try again.";
  }
  return body.slice(0, 500);
}

function App() {
  const [state, setState] = useState<State>();
  const [busy, setBusy] = useState<BusyResponse["attendees"]>([]);
  const [title, setTitle] = useState("");
  const [selection, setSelection] = useState<{ startsAt: string; endsAt: string }>();
  const [guests, setGuests] = useState<Guest[]>([]);
  const [guestEmail, setGuestEmail] = useState("");
  const [guestName, setGuestName] = useState("");
  const [fallbackEmails, setFallbackEmails] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void fetch("/api/planning/session", { credentials: "same-origin" })
      .then(async (response) => response.ok ? response.json() : Promise.reject(new Error(await responseError(response))))
      .then((next: State) => {
        setState(next); setTitle(next.session.title ?? ""); setSelection(next.session.selectedTime); setGuests(next.guests);
      })
      .catch((error: Error) => setMessage(error.message));
  }, []);

  const loadBusy = useCallback(async (start: Date, end: Date) => {
    const response = await fetch(`/api/planning/availability?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`, { credentials: "same-origin" });
    if (!response.ok) throw new Error(await responseError(response));
    const payload = await response.json() as BusyResponse;
    setBusy(payload.attendees);
  }, []);

  const events = useMemo(() => busy.flatMap((attendee, index) => attendee.busy.map((interval) => ({
    start: interval.startsAt, end: interval.endsAt, display: "background", backgroundColor: colors[index % colors.length], extendedProps: { attendeeId: attendee.id },
  }))), [busy]);
  const unavailable = state?.attendees.filter((attendee) => attendee.readiness !== "ready") ?? [];
  const selectionConflicts = selection ? busy.filter((attendee) => attendee.busy.some((interval) => new Date(interval.startsAt) < new Date(selection.endsAt) && new Date(selection.startsAt) < new Date(interval.endsAt))) : [];
  const needsOverride = selectionConflicts.length > 0 || unavailable.length > 0;

  function requiresAvailabilityOverride(nextSelection = selection) {
    const conflicts = nextSelection ? busy.some((attendee) => attendee.busy.some((interval) => new Date(interval.startsAt) < new Date(nextSelection.endsAt) && new Date(nextSelection.startsAt) < new Date(interval.endsAt))) : false;
    return conflicts || unavailable.length > 0;
  }

  async function saveDraft(nextSelection = selection, nextGuests = guests, nextTitle = title) {
    setSaving(true);
    try {
      const response = await fetch("/api/planning/draft", { method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: nextTitle, startsAt: nextSelection?.startsAt, endsAt: nextSelection?.endsAt, guests: nextGuests, availabilityOverride: requiresAvailabilityOverride(nextSelection) }) });
      if (!response.ok) throw new Error(await responseError(response));
      setMessage("Draft saved.");
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to save the draft.");
      return false;
    } finally { setSaving(false); }
  }

  function addGuest() {
    const email = guestEmail.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) { setMessage("Enter a valid guest email."); return; }
    const next = [...guests.filter((guest) => guest.email !== email), { displayName: guestName.trim() || email, email }];
    setGuests(next); setGuestEmail(""); setGuestName(""); void saveDraft(selection, next);
  }

  async function useFallbackEmail(attendee: Attendee) {
    const email = fallbackEmails[attendee.id]?.trim().toLowerCase();
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) { setMessage("Enter a valid fallback email."); return; }
    setSaving(true);
    try {
      const response = await fetch("/api/planning/fallback-email", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ attendeeId: attendee.id, email }) });
      if (!response.ok) throw new Error(await responseError(response));
      const updated = await response.json() as Attendee;
      setState((current) => current ? { ...current, attendees: current.attendees.map((item) => item.id === updated.id ? updated : item) } : current);
      setMessage(`${attendee.displayName} will be invited, but their availability remains unverified.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to save fallback email."); } finally { setSaving(false); }
  }

  async function confirm() {
    if (!title.trim()) { setMessage("Choose a meeting title before confirming."); return; }
    if (!selection) { setMessage("Choose a meeting time before confirming."); return; }
    if (!await saveDraft(selection, guests, title)) return;
    setSaving(true);
    try {
      const response = await fetch("/api/planning/confirm", { method: "POST", credentials: "same-origin" });
      if (!response.ok) throw new Error(await responseError(response));
      const result = await response.json() as { meetingId: string; calendarSync: "accepted" | "deferred" };
      console.info("[planner] calendar sync handoff", result);
      setMessage(result.calendarSync === "accepted"
        ? `Confirmed. Creating Calendar invitations for meeting ${result.meetingId}.`
        : `Confirmed. Calendar synchronization for meeting ${result.meetingId} is queued for automatic retry.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to confirm the meeting."); } finally { setSaving(false); }
  }

  if (!state) return <main className="loading">{message || "Loading your planning session…"}</main>;
  return <main className="planner">
    <header><div><p className="eyebrow">Tech@NYU coordinator</p><h1>Plan a meeting</h1></div><p className="expiry">Session expires {new Date(state.session.expiresAt).toLocaleString()}</p></header>
    <section className="details"><label>Meeting title<input value={title} onChange={(event) => setTitle(event.target.value)} onBlur={() => void saveDraft()} placeholder="Leadership meeting" /></label><button onClick={() => void saveDraft()} disabled={saving}>Save draft</button></section>
    <section className="workspace">
      <div className="calendar"><FullCalendar plugins={[timeGridPlugin, interactionPlugin]} initialView="timeGridWeek" allDaySlot={false} slotDuration="00:15:00" snapDuration="00:15:00" selectable selectMirror events={events} datesSet={(info) => void loadBusy(info.start, info.end).catch((error: Error) => setMessage(error.message))} select={(info) => { const next = { startsAt: info.start.toISOString(), endsAt: info.end.toISOString() }; setSelection(next); void saveDraft(next); }} height="auto" /></div>
      <aside>
        <h2>Availability</h2><ul className="legend">{state.attendees.map((attendee, index) => <li key={attendee.id}><i style={{ background: colors[index % colors.length] }} />{attendee.displayName}<small>{attendee.readiness.replaceAll("_", " ")}</small>{attendee.readiness !== "ready" && attendee.readiness !== "unverified" && <span className="fallback"><input value={fallbackEmails[attendee.id] ?? ""} onChange={(event) => setFallbackEmails((current) => ({ ...current, [attendee.id]: event.target.value }))} placeholder="Fallback invite email" /><button onClick={() => void useFallbackEmail(attendee)} disabled={saving}>Use email</button></span>}</li>)}</ul>
        <h2>Selected time</h2>{selection ? <p>{new Date(selection.startsAt).toLocaleString()} – {new Date(selection.endsAt).toLocaleTimeString()}</p> : <p>Drag on the calendar to select a time.</p>}
        {selectionConflicts.length > 0 && <p className="warning">Busy: {selectionConflicts.map((attendee) => attendee.displayName).join(", ")}</p>}
        {unavailable.length > 0 && <p className="warning">Unverified: {unavailable.map((attendee) => attendee.displayName).join(", ")}</p>}
        {selection && <><h2>Email guests</h2><input value={guestName} onChange={(event) => setGuestName(event.target.value)} placeholder="Guest name (optional)" /><input value={guestEmail} onChange={(event) => setGuestEmail(event.target.value)} placeholder="guest@example.com" /><button onClick={addGuest}>Add guest</button><ul>{guests.map((guest) => <li key={guest.email}>{guest.displayName}</li>)}</ul><button className="confirm" onClick={() => void confirm()} disabled={saving}>{needsOverride ? "Confirm despite conflicts" : "Confirm meeting"}</button></>}
        {message && <p className="message">{message}</p>}
      </aside>
    </section>
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
