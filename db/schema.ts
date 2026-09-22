import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const owners = sqliteTable("owners", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  initials: text("initials").notNull(),
});

export const companies = sqliteTable("companies", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  domain: text("domain").notNull().unique(),
});

export const prospects = sqliteTable("prospects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull().default(""),
  email: text("email").notNull(),
  normalizedEmail: text("normalized_email").notNull(),
  title: text("title").notNull().default(""),
  source: text("source").notNull().default("manual"),
  status: text("status").notNull().default("new"),
  ownerId: integer("owner_id").references(() => owners.id),
  companyId: integer("company_id").references(() => companies.id),
  nextAction: text("next_action"),
  deadlineAt: text("deadline_at"),
  closeUrl: text("close_url"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("idx_prospects_normalized_email").on(table.normalizedEmail)]);

export const campaigns = sqliteTable("campaigns", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  provider: text("provider").notNull().default("smartlead"),
  externalId: text("external_id").notNull(),
}, (table) => [uniqueIndex("idx_campaign_provider_external").on(table.provider, table.externalId)]);

export const externalRefs = sqliteTable("external_refs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  provider: text("provider").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: integer("entity_id").notNull(),
  externalId: text("external_id").notNull(),
  metadataJson: text("metadata_json").notNull().default("{}"),
}, (table) => [uniqueIndex("idx_external_ref_identity").on(table.provider, table.entityType, table.externalId)]);

export const integrationEvents = sqliteTable("integration_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  provider: text("provider").notNull(),
  externalEventId: text("external_event_id").notNull(),
  eventType: text("event_type").notNull(),
  payloadJson: text("payload_json").notNull(),
  processedAt: text("processed_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("idx_events_provider_external").on(table.provider, table.externalEventId)]);

export const replies = sqliteTable("replies", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  prospectId: integer("prospect_id").notNull().references(() => prospects.id),
  campaignId: integer("campaign_id").references(() => campaigns.id),
  providerReplyId: text("provider_reply_id").notNull().unique(),
  body: text("body").notNull(),
  sentiment: text("sentiment").notNull().default("positive"),
  receivedAt: text("received_at").notNull(),
});

export const meetings = sqliteTable("meetings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  prospectId: integer("prospect_id").references(() => prospects.id),
  bookingUid: text("booking_uid").notNull().unique(),
  title: text("title").notNull(),
  startsAt: text("starts_at").notNull(),
  endsAt: text("ends_at"),
  status: text("status").notNull(),
  attendeeEmail: text("attendee_email").notNull(),
  bookingUrl: text("booking_url"),
});

export const syncJobs = sqliteTable("sync_jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  provider: text("provider").notNull(),
  operation: text("operation").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  payloadJson: text("payload_json").notNull(),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  nextRetryAt: text("next_retry_at"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const prospectTransitions = sqliteTable("prospect_transitions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  prospectId: integer("prospect_id").notNull().references(() => prospects.id),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  reason: text("reason").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
