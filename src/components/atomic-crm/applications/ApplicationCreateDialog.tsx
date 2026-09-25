import { useState } from "react";
import {
  required,
  useCreate,
  useDataProvider,
  useGetIdentity,
  useNotify,
  useRefresh,
  useTranslate,
  type Identifier,
} from "ra-core";
import { Link } from "react-router";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AutocompleteInput } from "@/components/admin/autocomplete-input";
import { ReferenceInput } from "@/components/admin/reference-input";

import { CreateDialog } from "../misc/CreateDialog";
import { createManualApplication } from "./createManualApplication";
import { doNotEngageValidator } from "../contacts/doNotEngageGuard";
import { personOptionText } from "../deals/PersonOption";
import { ApplicationProgramFields } from "./ApplicationProgramFields";
import { findDealLabel } from "../deals/dealUtils";
import { useConfigurationContext } from "../root/ConfigurationContext";
import type { Contact, Offer } from "../types";

// "+ New Application" — an Application Leif enters herself.
//
// It records one thing: that this person genuinely applied to this
// programme, and that she is the one entering it. It is not a form
// submission, so there are no answers; it is not an import, so it is not
// history; and it is not reviewed, so it starts pending and appears in
// that programme's Needs Review beside everything else waiting on her.
//
// source is owned by this dialog rather than asked. Leif choosing
// "manual" from a dropdown would be a chance to record something untrue
// about where a record came from, and there is no version of that question
// she should have to answer.
//
// The save is a domain action, not a resource create. A current-funnel
// Application also establishes the canonical Application Received
// Opportunity that the review workflow writes to — one transaction, or
// neither record. See createManualApplication.ts.
export const ApplicationCreateDialog = ({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const translate = useTranslate();
  const dataProvider = useDataProvider();
  const notify = useNotify();
  const refresh = useRefresh();
  const { dealStages } = useConfigurationContext();
  const [saving, setSaving] = useState(false);
  const [liveSale, setLiveSale] = useState<{
    opportunityId: Identifier;
    stageLabel: string;
    offerName: string;
  } | null>(null);

  const handleSubmit = async (values: Record<string, unknown>) => {
    if (saving) return;
    setSaving(true);
    try {
      setLiveSale(null);
      const result = await createManualApplication(dataProvider, {
        contactId: values.contact_id as Identifier,
        offerId: values.offer_id as Identifier,
        cohortId: (values.intended_cohort_id as Identifier) ?? null,
      });

      if (result.status === "later-stage") {
        // The sale is live and already past the point a review speaks to.
        // Shown rather than refused in the abstract: the answer to "record
        // this application" is that the conversation it would start is
        // already happening, so the useful thing is a way into it.
        const { data: offer } = await dataProvider.getOne<Offer>("offers", {
          id: values.offer_id as Identifier,
        });
        setLiveSale({
          opportunityId: result.opportunityId,
          stageLabel: findDealLabel(dealStages, result.stage) ?? result.stage,
          offerName: offer.name,
        });
        return;
      }

      if (result.status === "already-pending") {
        // Not an error and not a second record: this person already has an
        // application waiting on her for this programme. Said plainly
        // rather than silently duplicated or silently merged.
        notify("resources.applications.create.already_pending", {
          type: "warning",
          messageArgs: {
            _: "This person already has an application waiting for you in this programme.",
          },
        });
        onOpenChange(false);
        refresh();
        return;
      }

      if (result.status !== "created") {
        notify("resources.applications.create.refused", {
          type: "error",
          messageArgs: {
            _: "That application could not be created — check the person and programme.",
          },
        });
        return;
      }

      notify("resources.applications.notifications.created", {
        type: "info",
        messageArgs: { smart_count: 1, _: "Application created" },
      });
      onOpenChange(false);
      refresh();
    } catch {
      notify("ra.notification.http_error", { type: "error" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <CreateDialog
      resource="applications"
      title={translate("resources.applications.action.create", {
        _: "New Application",
      })}
      open={open}
      onOpenChange={onOpenChange}
      onSubmit={handleSubmit}
    >
      <div className="flex flex-col gap-4">
        {liveSale && (
          <Alert>
            <AlertTitle>
              {translate("resources.applications.create.live_sale_title", {
                _: "There is already a live sales process",
              })}
            </AlertTitle>
            <AlertDescription className="flex flex-col gap-1">
              <span>
                {translate("resources.applications.create.live_sale_body", {
                  _: "This person already has an active %{stage} opportunity for %{offer}. Open that sales process instead.",
                  stage: liveSale.stageLabel,
                  offer: liveSale.offerName,
                })}
              </span>
              <Link
                to={`/deals/${liveSale.opportunityId}/show`}
                className="font-medium underline"
                onClick={() => onOpenChange(false)}
              >
                {translate("resources.applications.create.live_sale_link", {
                  _: "Open the opportunity",
                })}
              </Link>
            </AlertDescription>
          </Alert>
        )}
        <ApplicationPersonInput />
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {translate("resources.applications.program", { _: "Program" })}
          </h3>
          <ApplicationProgramFields />
        </div>
      </div>
    </CreateDialog>
  );
};

// The same person field the Opportunity and Waitlist forms use: search
// every existing Contact first so a returning applicant is never
// duplicated, inline-create only when nobody matches, and Do Not Engage
// stays visible but blocks the save. Identity still flows through
// contacts_summary and the one contacts create — no second person model.
const ApplicationPersonInput = () => {
  const translate = useTranslate();
  const [create] = useCreate();
  const { identity } = useGetIdentity();
  const notify = useNotify();
  const dataProvider = useDataProvider();

  const doNotEngageMessage = translate(
    "resources.applications.person_input.do_not_engage_error",
    {
      _: "This person is marked Do Not Engage — no application can be created for them.",
    },
  );

  const handleCreatePerson = async (name?: string) => {
    if (!name) return;
    const [firstName, ...rest] = name.trim().split(/\s+/).filter(Boolean);
    try {
      return await create(
        "contacts",
        {
          data: {
            first_name: firstName ?? name,
            last_name: rest.join(" "),
            email_jsonb: [],
            phone_jsonb: [],
            tags: [],
            sales_id: identity?.id,
            first_seen: new Date().toISOString(),
            last_seen: new Date().toISOString(),
          },
        },
        { returnPromise: true },
      );
    } catch {
      notify("resources.applications.person_input.create_error", {
        type: "error",
        messageArgs: { _: "An error occurred while creating the person" },
      });
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {translate("resources.applications.person", { _: "Person" })}
      </h3>
      <ReferenceInput source="contact_id" reference="contacts_summary">
        <AutocompleteInput
          label={false}
          placeholder={translate("resources.deals.person_input.placeholder", {
            _: "Search by name or email…",
          })}
          optionText={personOptionText}
          inputText={(choice: Contact | undefined) =>
            choice ? `${choice.first_name} ${choice.last_name}` : ""
          }
          helperText={false}
          validate={[
            required(),
            doNotEngageValidator(dataProvider, doNotEngageMessage),
          ]}
          onCreate={handleCreatePerson}
          createLabel="resources.deals.person_input.create_label"
          createItemLabel="resources.deals.person_input.create_item_label"
        />
      </ReferenceInput>
    </div>
  );
};
