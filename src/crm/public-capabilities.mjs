// Local beneficiary effects, separate from the complete institutional API
// contract. A transport write records data; it does not prove a real-world
// service was performed. Keep these semantics shared by authors and reviewers.
const reference={effect:'read_reference',produces:'Returned classification/reference values only; no business transaction, case change or service delivery.'};
const detail={effect:'read_case',produces:'Returned fields of the identified beneficiary record, including recorded status when present. Does not modify status or prove on-site progress.'};
export const PUBLIC_EFFECTS={
  crm_get_assets:{effect:'read_asset_catalogue',produces:'Main asset categories and identifiers, not individual places, coordinates, opening hours or nearby search.'},
  crm_get_asset_details:{effect:'read_asset_catalogue',produces:'Sub-asset/category details under a returned main asset, not a map of nearby facilities.'},
  crm_get_incidents:{effect:'read_case_history',produces:'The signed-in beneficiary visible history and returned recorded statuses. A history row is not automatically the requested target.'},
  crm_fetch_incident:detail,crm_fetch_municipal_service:detail,crm_fetch_inquiry:detail,
  crm_get_main_classifications:reference,crm_get_sub_classifications:reference,
  crm_get_special_classifications:reference,crm_get_special_classifications_by_type:reference,
  crm_get_classification_parents:reference,crm_retrieve_msr_data:reference,crm_retrieve_tsr_data:reference,
  crm_create_municipal_service:{effect:'create_crm_request',produces:'A municipal CRM request record for an evidenced classification. Recording a request is not execution of the underlying municipal service.'},
  crm_create_inquiry:{effect:'create_crm_inquiry',produces:'A classified CRM inquiry record. It does not perform the subject of the inquiry.'},
  crm_create_daem_ticket:{effect:'create_support_ticket',produces:'A Daem technical-support ticket record, not a municipal permit, field-work order or fulfilled repair.'},
  crm_create_form_request:{effect:'create_public_contact_record',produces:'A public inquiry, suggestion or complaint record. It is a separate chosen service, not execution of the subject of the complaint.'},
  crm_upload_file:{effect:'upload_case_file',produces:'An attachment linked to an existing case from actually selected bytes; not a new case or physical action.'},
  crm_upload_attachment:{effect:'upload_form_file',produces:'An attachment identifier for a later public form from actually selected bytes; not a submitted complaint.'},
  crm_download_file:{effect:'download_case_file',produces:'Actual file content only after a successful download with an actual FileKey. A hasAttachments flag or missing key is not file content and does not mean this download capability is unconnected.'}
};

export const PUBLIC_EFFECT_RULES=`The public_effect manifest defines the ACTUAL PRODUCT of each connected operation. API names, generic CRM classifications and a successful transport write cannot expand that product. Distinguish a CRM report/inquiry/contact RECORD from performance of the service it discusses. No public operation grants, issues or renews a permit/licence, pays or refunds money, reopens/closes/escalates a case, changes priority, dispatches workers, repairs an object, or sends a real notification. Institutional mutation callbacks are outside this beneficiary toolset. A complaint about one of those subjects is a separately chosen record, never the requested underlying transaction.
A request for recorded progress can use connected case reads. A request to MODIFY a case is a different effect: never reinterpret it as a read merely because reads exist. Urgency alone requests no mutation. Likewise, an unsupported transaction must not be replaced with a generic create operation whose actual product lacks that effect; a resulting true missing-location observation cannot explain why the original unsupported transaction failed.
Separate (1) connected ability, (2) required inputs/authentication, (3) a call actually attempted, and (4) fields/bytes actually returned. Connected case reads can show recorded status, but cannot prove physical progress or modify it. Connected file download still needs a real key and successful bytes; absence of those proves only that this file has not been retrieved, not that all file viewing/downloading is unavailable. Public consumer-auth contact forms do not require beneficiary demo sign-in; sso operations do. Treat these distinctions the same way in questions, choices, plans, payloads and final explanations. In simulation every record is local and has no external fulfilment or handoff.
There is no connected official contact/transaction directory. Specific official phone numbers, URLs or claims that a particular external channel handles a transaction require actual verified FAQ evidence. An API sourceSystem brand/example or model memory is not that evidence. Without it, suggest only a separate official channel in general terms; never send a local record number there for tracking.`;

export function publicEffect(operation){return PUBLIC_EFFECTS[operation.id]?{...PUBLIC_EFFECTS[operation.id],beneficiary_sign_in_required:operation.auth==='sso'}:null;}
