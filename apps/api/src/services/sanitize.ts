import type { ResourceNode } from '@contake/core';

/** QA-M2-3 standing rule: any frame/response to field_manager/focus_worker is
 *  subscriber-filtered — group resources never carry subscriberChannelIds (or any
 *  subscriber-channel field) outside admin surfaces. */
export function stripSubscriberFields(resources: ResourceNode[]): ResourceNode[] {
  return resources.map(r => {
    if (r.subscriberChannelIds === undefined) return r;
    const { subscriberChannelIds: _stripped, ...rest } = r;
    return rest;
  });
}

/** contracts v1.12: ResourceNode.contactPhone is manager-roles visibility only
 *  (admin, field_manager) - NEVER emitted to focus_worker payloads. Applied at
 *  the focus_worker branch of filteredGraph; manager surfaces keep the field. */
export function stripContactPhone(resources: ResourceNode[]): ResourceNode[] {
  return resources.map(r => {
    if (r.contactPhone === undefined) return r;
    const { contactPhone: _stripped, ...rest } = r;
    return rest;
  });
}
