---
name: crm940-municipal-complaint
description: Use for municipal complaint lookup/history, complaint creation or reopening closed unresolved complaints through the 940 mock adapter.
---
Ask complaint_id for lookup/history/reopen. Closed does not prove the problem was resolved. Reopen requests need existing status when not already observed and a user-provided reason. User report can be summarized faithfully, never invent a location or fact.
Create categories: municipal_service_delay, waste, streetlight, current_hazard. Require parcel_id or related_application_id. When a user asks to complain about a BALADY delay, inspect that application if needed, then propose creation.
Writes require host confirmation of exact parameters; stop on needs_confirmation. Reuse exact proposal after confirmation. Return created/reopened, never actual repair. A present hazard is safety information independent of expressed worry; do not mark the emergency resolved.
