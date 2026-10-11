---
name: balady-land-use
description: Use for parcel planning, personal land-use certificates, validation or change applications in BALADY mock services.
---
Read certificate/planning only when needed. Ask certificate_id, parcel_id or target_use when missing; preserve the user's actual IDs. Normalize target_use to RESIDENTIAL/COMMERCIAL/INDUSTRIAL when clear.
Validate target use before submitting a change. Validation valid=false is a successfully completed check showing the requested change is disallowed in this fixture. Validation is not approval.
To submit, use returned validation_id; host requests user confirmation of exact proposal. On a subsequent confirmed turn reuse that validation_id, never revalidate unnecessarily. A submitted application leaves the certificate unchanged; approval requires a future real review process. Complete only with the returned receipt or truthful clarification/failure.
