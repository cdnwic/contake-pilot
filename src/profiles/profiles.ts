import { z } from 'zod';
import type { DomainProfile } from '../contracts/contake-core-contracts.v1.1';
import profilesJson from './profiles.v1.json' with { type: 'json' };

/** Domain profiles (drop-in fixtures, QA-approved v1.1). Validated at load:
 *  a malformed profile fails loudly at startup/test, never mid-day. */

const hhmm = z.string().regex(/^\d{2}:\d{2}$/);

const profileSchema = z.object({
  id: z.string().min(1),
  displayNameHe: z.string().min(1),
  labels: z.object({
    event: z.string().min(1),
    task: z.string().min(1),
    resource: z.object({
      person: z.string().min(1),
      equipment: z.string().min(1),
      location: z.string().min(1),
      group: z.string().min(1),
    }).strict(),
    role: z.object({
      admin: z.string().min(1),
      field_manager: z.string().min(1),
      focus_worker: z.string().min(1),
    }).strict(),
    // v1.17 optional plural + chrome labels (stage-0 multi-vertical)
    eventPlural: z.string().min(1).optional(),
    taskPlural: z.string().min(1).optional(),
    resourcePlural: z.object({
      person: z.string().min(1),
      equipment: z.string().min(1),
      location: z.string().min(1),
      group: z.string().min(1),
    }).strict().optional(),
    rolePlural: z.object({
      admin: z.string().min(1),
      field_manager: z.string().min(1),
      focus_worker: z.string().min(1),
    }).strict().optional(),
    chrome: z.object({
      tower: z.string().min(1).optional(),
      focus: z.string().min(1).optional(),
      approvals: z.string().min(1).optional(),
      builder: z.string().min(1).optional(),
    }).strict().optional(),
  }),
  catalog: z.array(z.object({
    resourceKind: z.enum(['person', 'equipment', 'location', 'group']),
    name: z.string().min(1),
    exclusive: z.boolean(),
    capacity: z.number().int().positive().optional(), // RESERVED (QA D2)
  })),
  taskTemplates: z.array(z.object({
    name: z.string().min(1),
    durationMin: z.number().int().positive(),
    defaultAssigneeKinds: z.array(z.enum(['person', 'equipment', 'location', 'group'])),
  })),
  rules: z.object({
    maxShiftMin: z.number().int().positive().optional(),
    workingWindow: z.object({ startHHMM: hhmm, endHHMM: hhmm }).optional(),
    externalStakeholderLabel: z.string().optional(),
    quietHours: z.object({ startHHMM: hhmm, endHHMM: hhmm }).optional(),
  }),
  notificationTemplates: z.record(z.string(), z.string()),
}).strict();

const registrySchema = z.object({
  version: z.string(),
  profiles: z.array(profileSchema),
});

const parsed = registrySchema.parse(profilesJson);

export const PROFILES_VERSION: string = parsed.version;

const byId = new Map<string, DomainProfile>(
  parsed.profiles.map(p => [p.id, p as unknown as DomainProfile] as const),
);

export function listProfiles(): DomainProfile[] {
  return [...byId.values()];
}

export function getProfile(id: string): DomainProfile {
  const p = byId.get(id);
  if (!p) throw new Error(`unknown domain profile: ${id}`);
  return p;
}

export function hasProfile(id: string): boolean {
  return byId.has(id);
}
