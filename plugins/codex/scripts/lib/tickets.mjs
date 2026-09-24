import { randomBytes } from "node:crypto";
import fs from "node:fs";

import { writeJsonAtomic } from "./locking.mjs";
import {
  OPEN_TICKET_STATES,
  readTicketFile,
  resolveTicketFile,
  resolveTicketsDir,
  withStateLock
} from "./state.mjs";

export const TICKET_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,47}$/;
export const CLOSED_TICKET_STATES = new Set(["accepted", "rejected", "abandoned"]);
export { OPEN_TICKET_STATES };

function nowIso() {
  return new Date().toISOString();
}

export function isTicketOpen(ticket) {
  return Boolean(ticket && OPEN_TICKET_STATES.has(ticket.state));
}

export function deriveTicketId(text) {
  const words = String(text ?? "")
    .toLowerCase()
    .replace(/<[^>]+>/g, " ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((word) => word.replace(/^-+|-+$/g, ""))
    .filter((word) => word.length > 2 && !["the", "and", "for", "with", "that", "this", "from", "into"].includes(word))
    .slice(0, 4);
  const slug = words.join("-").slice(0, 36).replace(/-+$/, "") || "ticket";
  return `${slug}-${randomBytes(2).toString("hex")}`;
}

export function validateTicketId(id) {
  if (typeof id !== "string" || !TICKET_ID_PATTERN.test(id)) {
    throw new Error(`Invalid ticket name "${id}". Use 1-48 lowercase letters, digits, ".", "_" or "-", starting with a letter or digit.`);
  }
  return id;
}

export function readTicket(cwd, ticketId) {
  return readTicketFile(cwd, ticketId);
}

export function createTicket(cwd, ticket) {
  validateTicketId(ticket.id);
  return withStateLock(cwd, () => {
    if (readTicketFile(cwd, ticket.id)) {
      throw new Error(`Ticket "${ticket.id}" already exists. Pick another name, or use followup to continue it.`);
    }
    const record = { version: 1, createdAt: nowIso(), updatedAt: nowIso(), ...ticket };
    writeJsonAtomic(resolveTicketFile(cwd, ticket.id), record);
    return record;
  });
}

/** Read-modify-write a ticket under the state lock. `mutate` edits the record in place. */
export function updateTicket(cwd, ticketId, mutate) {
  return withStateLock(cwd, () => {
    const ticket = readTicketFile(cwd, ticketId);
    if (!ticket) {
      throw new Error(`No ticket named "${ticketId}".`);
    }
    mutate(ticket);
    ticket.updatedAt = nowIso();
    writeJsonAtomic(resolveTicketFile(cwd, ticketId), ticket);
    return ticket;
  });
}

export function listTickets(cwd, options = {}) {
  const dir = resolveTicketsDir(cwd);
  if (!fs.existsSync(dir)) {
    return [];
  }
  const tickets = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .map((name) => readTicketFile(cwd, name.slice(0, -".json".length)))
    .filter(Boolean)
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
  return options.includeClosed ? tickets : tickets.filter(isTicketOpen);
}

export function resolveTicketReference(cwd, reference) {
  if (!reference) {
    throw new Error("A ticket name is required.");
  }
  const exact = readTicketFile(cwd, reference);
  if (exact) {
    return exact;
  }
  const matches = listTickets(cwd, { includeClosed: true }).filter((ticket) => ticket.id.startsWith(reference));
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new Error(`Ticket reference "${reference}" is ambiguous: ${matches.map((ticket) => ticket.id).join(", ")}.`);
  }
  return null;
}
